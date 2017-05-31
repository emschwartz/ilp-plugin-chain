'use strict'

const chain = require('chain-sdk')
const debug = require('debug')('ilp-plugin-chain')
const EventEmitter = require('eventemitter3')
const assert = require('assert')
const moment = require('moment')
const base64url = require('base64url')
const uuid = require('uuid')

const escrow = require('./escrow')
const MESSAGE_STRING = 'messagemessagemessagemessagemessagemessagem='
const HttpRpc = require('./rpc')

module.exports = class PluginChain extends EventEmitter {
  constructor (opts) {
    super()

    this._client = opts.client || new chain.Client(opts.clientOpts)
    this._signer = opts.signer || new chain.HsmSigner(opts.signerOpts)
    this._assetAlias = opts.assetAlias
    this._assetId = opts.assetId
    this._accountAlias = opts.accountAlias
    this._accountId = opts.accountId
    this._currencyScale = opts.currencyScale || 0
    this._privateChainInstance = (opts.private !== true)
    this._configuredKey = opts.key // must include pubkey, rootXpub, pubkeyDerivationPath
    this._notificationPollInterval = opts.pollInterval || 500

    // HTTP RPC messaging
    this._rpcUris = opts.rpcUris || {} // map of ILP address to RPC URI
    this._rpc = new HttpRpc(this)
    this._rpc.addMethod('send_message', this._handleRpcMessage)
    // TODO: implement HTTP token authentication
    this.isAuthorized = () => true
    this.receive = this._rpc.receive.bind(this._rpc)

    this._connected = false
    this._disconnecting = false
    this._prefix = null
    this._info = null
    this._address = null
    this._receiver = null
    this._key = null
    this._expiryWatchers = {}
    this._notificationInterval = null
  }

  async connect () {
    // TODO make sure we reclaim all the previous escrows that expired
    debug('connect called')
    try {
      this._info = await this._getChainInfo()
      this._prefix = this._info.prefix
      this._address = this._prefix + this._accountId
      this._receiver = await this._createReceiver()
      this._key = await this._setPubkey(this._configuredKey)
      await this._listenForNotifications()
    } catch (err) {
      debug('error connecting to chain core:', err.body || err)
      throw new Error('Error connecting client: ' + err.message)
    }
    this._connected = true
    debug(`connected to chain blockchain: ${this._prefix}`)
    this._safeEmit('connect')
    return
  }

  async disconnect () {
    // TODO maybe delete the transactionFeed
    // we were deleting the feed before but that was causing issues because
    // the notification loop would try to get the next notifications after the
    // feed was deleted
    debug('disconnect called')
    this._connected = false
    this._disconnecting = true
    clearInterval(this._notificationInterval)
    this._safeEmit('disconnect')
  }

  isConnected () {
    // TODO handle if we lose connection to the server
    debug(`plugin is ${this._connected ? '' : 'not '} connected`)
    return this._connected
  }

  getAccount () {
    assert(this.isConnected(), 'must be connected to getAccount')
    return this._prefix + this._key.pubkey
  }

  getInfo () {
    return this._info
  }

  async getBalance () {
    debug(`requesting ${this._assetAlias} balance for account ${this._accountAlias}`)
    try {
      const queryPage = await this._client.unspentOutputs.query({
        filter: 'account_id=$1 AND asset_id=$2',
        filterParams: [this._accountId, this._assetId],
        pageSize: 100
      })
      // TODO: handle if this isn't the last page
      const utxos = queryPage.items
      const balance = utxos.reduce((balance, utxo) => {
        return balance + utxo.amount
      }, 0)
      return balance
    } catch (err) {
      debug('error getting balance', err)
      throw new Error('Error getting balance: ' + err.message)
    }
  }

  async getFulfillment (transferId) {
    // TODO handle errors finding transactions
    debug('getFulfillment for transfer:', transferId)
    const originalTransaction = await this._getTransactionByTransferId(transferId)
    let output
    for (output of originalTransaction.outputs) {
      if (output.referenceData.id === transferId) {
        break
      }
    }
    const fulfillingTransaction = await this._getTransactionSpendingOutput(output.id)
    let input
    for (input of fulfillingTransaction.inputs) {
      if (input.spentOutputId === output.id) {
        break
      }
    }

    if (input.arguments.length !== 3 || input.arguments[2] !== escrow.FULFILL_CLAUSE) {
      debug(`tried to get fulfillment for escrow that was not fulfilled. original escrow tx: ${originalTransaction.id}, tx that spent output: ${fulfillingTransaction.id}`)
      throw new Error('Transfer was not fulfilled')
    }

    // fulfillment is the first argument passed in as the witness
    return base64url.encode(input.arguments[0], 'hex')
  }

  async sendTransfer (transfer) {
    debug('sendTransfer', JSON.stringify(transfer))
    const transactionWithSameId = await this._getTransactionByTransferId(transfer.id)
    if (transactionWithSameId) {
      throw new Error('Duplicate ID error')
    }
    const sourceReceiver = await this._createReceiver(transfer.id)
    const destinationPubkey = transfer.to.replace(this._prefix, '')
    const utxoData = {
      // TODO minimize the data sent here
      id: transfer.id,
      sourcePubkey: this._key.pubkey,
      destinationPubkey,
      ilp: transfer.ilp,
      executionCondition: transfer.executionCondition,
      expiresAt: transfer.expiresAt,
      custom: transfer.custom,
      // TODO can this be put into "local" data?
      noteToSelf: transfer.noteToSelf
    }
    let escrowUtxo
    try {
      escrowUtxo = await escrow.create({
        client: this._client,
        signer: this._signer,
        assetId: this._assetId,
        sourceAccountId: this._accountId,
        sourceReceiver,
        destinationPubkey,
        amount: +transfer.amount,
        expiresAt: new Date(transfer.expiresAt),
        condition: base64url.decode(transfer.executionCondition, 'hex'),
        utxoData
      })
      debug(`sent conditional transfer ${transfer.id}, utxo: ${escrowUtxo.id}`)
    } catch (err) {
      if (err && err.body && err.body.code === 'CH706' && err.body.data.actions[0].message === 'Insufficient funds for tx') {
        debug(`insufficient funds to send transfer ${transfer.id}`)
        err.name = 'NotAcceptedError'
        err.message = 'Insufficient Funds'
        throw err
      } else {
        debug(`error creating escrow to prepare transfer ${transfer.id}:`, err)
        err.name = 'NotAcceptedError'
        err.message = JSON.stringify(err)
        throw err
      }
    }

    // Start timer for when transfer expires
    // TODO: also timeout all other expired holds that belong to us
    const expiryWatcher = setTimeout(() => {
      this._expireTransfer(escrowUtxo)
      delete this._expiryWatchers[transfer.id]
    }, moment(transfer.expiresAt).diff(moment()) + 1000) // expire it after the real expiresAt in case chain's clock is different
    this._expiryWatchers[transfer.id] = expiryWatcher

    return null
  }

  async fulfillCondition (transferId, fulfillment) {
    debug(`fulfillCondition for transfer ${transferId} with ${fulfillment}`)
    // TODO check if the transfer is already fulfilled
    const escrowUtxo = await this._getUtxoByTransferId(transferId)
    if (!escrowUtxo) {
      // TODO make this a proper ledger plugin error
      throw new Error(`Transfer not found: ${tranfserId}`)
    }
    const destinationReceiver = await this._createReceiver(transferId)
    try {
      const fulfillTx = await escrow.fulfill({
        client: this._client,
        signer: this._signer,
        fulfillment: base64url.decode(fulfillment, 'hex'),
        expiresAt: escrowUtxo.referenceData.expiresAt,
        destinationKey: {
          xpub: this._key.rootXpub,
          derivationPath: this._key.pubkeyDerivationPath
        },
        destinationReceiver,
        escrowUtxo
      })
      debug(`fulfilled transfer ${transferId} with tx: ${fulfillTx.id}`)
      return null
    } catch (err) {
      debug(`error fulfilling transfer ${transferId}`, err)
      throw err
    }
  }

  async rejectIncomingTransfer (transferId, rejectionReason) {
    debug('rejectIncomingTransfer', transferId, rejectionReason)
    const escrowUtxo = await this._getUtxoByTransferId(transferId)
    debug('fetched utxo:', escrowUtxo)
    if (!escrowUtxo) {
      // TODO throw a different error if the transfer existed but was already finalized
      // TODO make this a proper ledger plugin error
      throw new Error(`Transfer not found: ${tranfserId}`)
    }
    try {
      const rejectTx = await escrow.reject({
        client: this._client,
        signer: this._signer,
        destinationKey: {
          xpub: this._key.rootXpub,
          derivationPath: this._key.pubkeyDerivationPath
        },
        escrowUtxo,
        inputData: rejectionReason
      })
      debug(`rejected transfer ${transferId} with tx: ${rejectTx.id}`)
      return null
    } catch (err) {
      debug(`error rejecting transfer ${transferId}`, err)
      throw err
    }
  }

  async sendMessage (message) {
    // if the HTTP RPC URIs are configured, it'll send messages through that
    // otherwise it will send the message as a payment it knows the receiver
    // cannot fulfill

    // See if we have an HTTP RPC URI for the destination account
    if (this._rpcUris[message.to]) {
      this._rpc.call(
        this._rpcUris[message.to],
        'send_message',
        this._prefix,
        [message])

      this._safeEmit('outgoing_message', message)
      return
    }

    const transfer = {
      id: uuid(),
      from: this.getAccount(),
      to: message.to,
      ledger: this._prefix,
      amount: 1,
      executionCondition: MESSAGE_STRING,
      custom: message.data,
      expiresAt: moment().add(10, 'seconds').toISOString()
    }
    const sendTx = await this.sendTransfer(transfer)
    debug('sent message as ledger transaction', message)
    this._safeEmit('outgoing_message', message)
  }

  async _handleLedgerMessage (transfer) {
    // TODO verify this came from the "from" account
    const message = {
      from: transfer.from,
      to: transfer.to,
      ledger: this._prefix,
      data: transfer.custom
    }
    debug('got incoming message', message)
    this._safeEmit('incoming_message', message)
    // TODO responses could be implemented by rejecting the transfer
  }

  async _handleRpcMessage (message) {
    debug('got incoming RPC message', message)
    // TODO validate the fields
    this._safeEmit('incoming_message', message)
    return true
  }

  async _getChainInfo () {
    try {
      const info = await this._client.config.info()
      // TODO get currencyScale from the asset definition if it's there
      const currencyScale = this._currencyScale
      debug('chain blockchain info:', JSON.stringify(info))
      let scheme
      if (info.isProduction) {
        if (this._privateChainInstance) {
          scheme = 'private.'
        } else {
          scheme = 'g.'
        }
      } else {
        scheme = 'test.'
      }
      const ledgerPrefix = scheme + 'chain.' + info.blockchainId + '.' + this._assetId + '.'
      return {
        prefix: ledgerPrefix,
        currencyScale,
        currencyCode: this._assetAlias,
        connectors: []
      }
    } catch (err) {
      debug('error getting chain config info:', err)
      throw new Error('error getting chain config info: ' + err.message)
    }
  }

  async _setPubkey (configuredKey) {
    // TODO make this work with the real HSM
    const key = configuredKey || await this._client.accounts.createPubkey({
      accountId: this._accountId
    })
    this._signer.addKey(key.rootXpub, this._client.mockHsm.signerConnection)
    return key
  }

  async _createReceiver (alias) {
    debug('creating new receiver with alias: ', alias)
    try {
      const receiver = await this._client.accounts.createReceiver({
        accountId: this._accountId,
        alias: alias ? alias : undefined
      })
      debug('created new receiver with alias:', alias, receiver)
      return receiver
    } catch (err) {
      debug('error creating receiver', err)
      throw err
    }
  }

  _outputIsForUs (output) {
    return output.referenceData
      && output.referenceData.destinationPubkey
      && output.referenceData.destinationPubkey === this._key.pubkey
  }

  _outputIsFromUs (output) {
    return output.referenceData
      && output.referenceData.sourcePubkey
      && output.referenceData.sourcePubkey === this._key.pubkey
  }

  _parseTransferFromOutput (output) {
    // TODO add validation (including checking that someone didn't put our key in incorrectly)
    const transfer = {
      id: output.referenceData.id,
      amount: '' + output.amount,
      ledger: this._prefix,
      // TODO need a field that the sender cannot forge
      from: this._prefix + output.referenceData.sourcePubkey,
      to: this._prefix + output.referenceData.destinationPubkey,
      executionCondition: output.referenceData.executionCondition,
      ilp: output.referenceData.ilp,
      custom: output.referenceData.custom,
      expiresAt: output.referenceData.expiresAt
    }

    if (this._outputIsFromUs(output)) {
      transfer.noteToSelf = output.referenceData.noteToSelf
    }

    return transfer
  }

  async _handleNotification (tx) {
    debug('handling notification for tx: ' + tx.id)
    // Handle outgoing_{fulfill,reject} and incoming_{fulfill,reject}
    // If the transaction we just got notified about spends an output to/from us,
    // that means some transaction we were involved in was finalized
    for (let input of tx.inputs) {
      if (input.spentOutputId) {
        const originalTransaction = await this._getTransactionWithOutput(input.spentOutputId)
        for (let output of originalTransaction.outputs) {
          if (output.id === input.spentOutputId) {

            const transfer = this._parseTransferFromOutput(output)

            // ignore transfers related to ledger messaging
            if (transfer.executionCondition === MESSAGE_STRING) {
              break
            }

            let direction
            if (this._outputIsForUs(output)) {
              direction = 'incoming'
            } else if (this._outputIsFromUs(output)) {
              direction = 'outgoing'
            } else {
              break
            }
            const witness = input.arguments
            // The last part of the witness says which contract clause is being met
            const clause = witness[witness.length - 1]

            switch (clause) {
              case escrow.FULFILL_CLAUSE:
                const fulfillment = base64url.encode(witness[0], 'hex')

                // this is a holdover from when the transfer included a direction field
                // but the ilp-connector still depends on this for the moment
                // TODO: remove this field when the ilp-connector no longer depends on it
                transfer.direction = direction

                debug(`emitting ${direction}_fulfill:`, transfer, fulfillment)
                this._safeEmit(direction + '_fulfill', transfer, fulfillment)
                break
              case escrow.REJECT_CLAUSE:
                const inputReferenceData = input.referenceData && input.referenceData || {}
                const rejectionMessage = {
                  code: inputReferenceData.code,
                  name: inputReferenceData.name,
                  message: inputReferenceData.message,
                  triggeredBy: inputReferenceData.triggeredBy,
                  triggeredAt: inputReferenceData.triggeredAt
                }
                debug(`emitting ${direction}_reject (rejected by destination):`, transfer, rejectionMessage)
                this._safeEmit(direction + '_reject', transfer, rejectionMessage)
                break
              case escrow.TIMEOUT_CLAUSE:
                const timeoutMessage = {
                  code: 'R01',
                  name: 'Transfer Timed Out',
                  message: 'transfer timed out',
                  triggeredBy: this._address,
                  triggeredAt: (new Date()).toISOString()
                }
                debug(`emitting ${direction}_reject (transfer expired):`, transfer, timeoutMessage)
                this._safeEmit(direction + '_reject', transfer, timeoutMessage)
                break
              default:
                break
            }
          }
        }
      }
    }

    // Handle outgoing_prepare and incoming_prepare
    // If the transaction we just got notified about includes an output to/from us,
    // that means some transaction we were involved in was prepared
    for (let output of tx.outputs) {
      if (this._outputIsForUs(output)) {
        const transfer = this._parseTransferFromOutput(output)

        // intercept ledger messages
        if (transfer.executionCondition === MESSAGE_STRING) {
          this._handleLedgerMessage(transfer)
          break
        }

        // check that the incoming transfer is locked with the right control program
        await escrow.verify({
          utxo: output,
          client: this._client,
          sourceReceiver: output.referenceData.sourceReceiver,
          destinationPubkey: this._key.pubkey,
          amount: output.amount,
          assetId: output.assetId,
          // TODO decide on which part of the codebase is dealing with which date format
          expiresAt: moment(output.referenceData.expiresAt).valueOf(),
          condition: base64url.decode(output.referenceData.executionCondition, 'hex')
        })
        // TODO check that all the referenceData we expect is there
        debug('emitting incoming_prepare', transfer)
        try {
          this._safeEmit('incoming_prepare', transfer)
        } catch (err) {
          console.error('error in event handler', err)
        }
      } else if (this._outputIsFromUs(output)) {
        const transfer = this._parseTransferFromOutput(output)
        this._safeEmit('outgoing_prepare', transfer)
      }
    }
  }

  async _getNotifications (previousEndTime) {
    const filter = `(inputs(asset_id='${this._assetId}') OR outputs(asset_id='${this._assetId}'))`

    if (this._disconnecting) {
      return
    }

    const startTime = previousEndTime
    const endTime = Date.now()
    try {
      await this._client.transactions.queryAll({
        filter,
        startTime,
        endTime
      }, (notification) => {
        return this._handleNotification(notification)
          .catch((err) => {
            debug('error processing notification', err)
          })
      })
    } catch (err) {
      debug('error processing notifications', err)
    }
  }

  async _listenForNotifications () {
    let previousEndTime = Date.now()
    this._notificationInterval = setInterval(() => {
      this._getNotifications(previousEndTime)
      previousEndTime = Date.now()
    }, this._notificationPollInterval)
  }

  async _getTransactionWithOutput (outputId) {
    try {
      const queryPage = await this._client.transactions.query({
        filter: 'outputs(asset_id=$1 AND id=$2)',
        filterParams: [this._assetId, outputId],
        pageSize: 1
      })
      const transactions = queryPage.items
      // TODO there should only be one item, handle the case where there are more
      return transactions[0]
    } catch (err) {
      debug(`error getting transaction for transferId: ${transferId}`, err)
      throw err
    }
  }

  async _getTransactionSpendingOutput (outputId) {
    try {
      const queryPage = await this._client.transactions.query({
        filter: 'inputs(asset_id=$1 AND spent_output_id=$2)',
        filterParams: [this._assetId, outputId],
        pageSize: 100
      })
      const transactions = queryPage.items
      if (transactions.length > 1) {
        debug('found multiple transactions spending same output id: ', transactions)
      }
      // TODO there should only be one item, handle the case where there are more
      return transactions[0]
    } catch (err) {
      debug(`error getting transaction for transferId: ${transferId}`, err)
      throw err
    }
  }

  async _getTransactionByTransferId (transferId) {
    try {
      const queryPage = await this._client.transactions.query({
        filter: 'outputs(asset_id=$1 AND reference_data.id=$2)',
        filterParams: [this._assetId, transferId],
        pageSize: 100
      })
      const transactions = queryPage.items
      // TODO there should only be one item, handle the case where there are more
      return transactions[0]
    } catch (err) {
      debug(`error getting transaction for transferId: ${transferId}`, err)
      throw err
    }
  }

  // Returns transfer or null if transfer does not exist
  async _getUtxoByTransferId (transferId) {
    try {
      const queryPage = await this._client.unspentOutputs.query({
        filter: 'asset_id=$1 AND reference_data.id=$2',
        filterParams: [this._assetId, transferId],
        pageSize: 100
      })
      const utxos = queryPage.items
      // TODO there should only be one item, handle the case where there are more
      return utxos[0]
    } catch (err) {
      debug(`error getting utxo for transferId: ${transferId}`, err)
      throw err
    }
  }

  async _expireTransfer (escrowUtxo) {
    // TODO handle if the transfer is already fulfilled
    debug('checking whether we need to expire transfer:', escrowUtxo.referenceData.id)
    try {
      const utxo = await this._getUtxoByTransferId(escrowUtxo.referenceData.id)
      if (!utxo) {
        // don't try to expire transfers that have already been spent
        debug('transfer was already finalized:', escrowUtxo.referenceData.id)
        return
      }
      const resultTx = await escrow.timeout({
        client: this._client,
        signer: this._signer,
        escrowUtxo
      })
      debug(`expired transfer: ${escrowUtxo.referenceData.id}, tx: ${resultTx.id}`)
    } catch (err) {
      debug('error expiring transfer:' + escrowUtxo.referenceData.id, JSON.stringify(err))
    }
  }

  _safeEmit () {
    try {
      this.emit.apply(this, arguments)
    } catch (err) {
      debug('error in handler for event', arguments, err)
    }
  }
}
