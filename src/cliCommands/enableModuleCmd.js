const logger = require('debug-logger')('cli:createCmd')
const { loadConf, validateDisableModule, validateSignOffline } = require('../conf')
const { getContracts } = require('../contracts')
const inquirer = require('inquirer')
const getWeb3 = require('../getWeb3')
const util = require('util');
const assert = require('assert')
const lightwallet = require('eth-lightwallet')
const createVault = util.promisify(lightwallet.keystore.createVault).bind(lightwallet.keystore)
const safeUtils = require('@gnosis.pm/safe-contracts/test/utils')

function registerCommand({ cli }) {
  cli.command('enable-module [--conf file]', 'Enables dx module from safe contract. For this operation, if MNEMONIC or private keys provided, it should have ownership of the safe.', yargs => {
    yargs.option('conf', {
      type: 'string',
      describe: 'The file to read the configuration'
    })
  }, async function (argv) {
    const { conf } = argv

    const jsonConf = loadConf(conf)
    await validateDisableModule(jsonConf)

    // Obtain factories addresses
    const contracts = await getContracts(jsonConf)

    const web3 = await getWeb3()
    const networkID = await util.promisify(web3.version.getNetwork)()
    const accounts = await util.promisify(web3.eth.getAccounts)()

    const moduleInstance = await contracts.DutchXCompleteModule.at(jsonConf.dxModule)
    const safeInstance = await contracts.GnosisSafe.at(jsonConf.safe)
    const dxProxy = await contracts.DutchExchangeProxy.deployed()

    let safeTransactions = []
    let safeNonce = await safeInstance.nonce()

    const enabledModules = await safeInstance.getModules()
    const isModuleEnabled = enabledModules.includes(moduleInstance.address) ? true : false

    if (isModuleEnabled) {
      logger.info("Nothing to be done, already enabled")
      process.exit(0)
    }

    const multisigData = safeInstance.enableModule.request(jsonConf.dxModule).params[0].data
    let multisigHash = await safeInstance.getTransactionHash(safeInstance.address, 0, multisigData, 0, 0, 0, 0, 0, 0, safeNonce)
    safeTransactions.push({ data: multisigData, multisigHash, safeNonce })

    if (process.env.MNEMONIC || process.env.PK) {

      // accounts are already set in web3.eth.accounts, we need to validate that we have enough owners
      const safeThreshold = await safeInstance.getThreshold()
      const safeOwners = await safeInstance.getOwners()

      logger.info(`Safe contract ${jsonConf.safe} has a threshold of ${safeThreshold} owner/s`)
      logger.info(`Safe Owners: ${safeOwners}`)

      const availableOwners = accounts.filter(account => safeOwners.includes(account))
      assert(availableOwners.length >= safeThreshold, `Not enough owners provided in the MNEMONIC/PK. ${availableOwners.length} owner/s out of ${safeThreshold}`)

      logger.info(`Enough owners available through MNEMONIC/PK ${availableOwners.length} of ${safeOwners.length}`)

      // convert web3 provider into lightwallet, so we can perform the signatures
      let ownersLightwallet
      if (process.env.MNEMONIC) {
        const keystore = await createVault({
          hdPathString: "m/44'/60'/0'/0",
          seedPhrase: process.env.MNEMONIC,
          password: "supersecret",
          salt: "supersecretsalt"
        })

        const keyFromPassword = await util.promisify(keystore.keyFromPassword).bind(keystore)("supersecret")
        keystore.generateNewAddress(keyFromPassword, 10)
        ownersLightwallet = {
          keystore,
          passwords: keyFromPassword
        }
      }
      else {
        assert(false, "not implemented yet")
      }


      // Dry run
      logger.info("----------------------------------------------------------------------------------")
      logger.info("Ethereum Network ID:          ", networkID)
      logger.info("Ethereum Accounts:            ", JSON.stringify(accounts))
      logger.info("Safe Owners:                  ", JSON.stringify(jsonConf.owners))
      logger.info("----------------------------------------------------------------------------------")

      const { confirmation } = await inquirer.prompt(
        {
          name: "confirmation",
          type: "confirm",
          message: `ARE YOU SURE YOU WANT TO ENABLE THE MODULE?`
        }
      )
      if (!confirmation) {
        logger.info("Exit.")
        process.exit(0)
      }

      logger.info("Generating signatures")
      for (var i = 0; i < safeTransactions.length; i++) {
        safeTransaction = safeTransactions[i]
        const signatures = safeUtils.signTransaction(ownersLightwallet, availableOwners.slice(0, safeThreshold + 1), safeTransaction.multisigHash)
        safeTransaction.signatures = signatures
      }
    }

    // Iterate multisig transactions
    // If it has signatures, perform the execTransactions with off-chain meta transactions
    // If none signature provided, print raw transaction that has to be performed by the user
    for (var i = 0; i < safeTransactions.length; i++) {
      safeTransaction = safeTransactions[i]
      logger.info(`Safe transaction ${i}:`)
      if (safeTransaction.signatures) {
        logger.info('MNEMONIC/PK present, performing transaction...')
        logger.debug(JSON.stringify(safeTransaction, null, 2))
        const safeTx = await safeInstance.execTransaction(safeInstance.address, 0, safeTransaction.data, 0, 0, 0, 0, 0, 0, safeTransaction.signatures, { from: accounts[0], gas: 1e6, gasPrice: jsonConf.gasPrice })
        logger.info(`Safe transaction succesfully executed at tx ${safeTx.tx}`)
      }
      else {
        await validateSignOffline(jsonConf)
        const ownersToSign = jsonConf.ownersToSign.sort()

        const safeThreshold = await safeInstance.getThreshold()

        logger.info("DX Proxy address              ", dxProxy.address)
        logger.info('No MNEMONIC/PK present, you need to manually perform these transactions:')
        logger.info(`Send this transaction with the ${safeThreshold} owner/s [${ownersToSign}] :`)
        const approveHash = await safeInstance.approveHash.request(safeTransaction.multisigHash, { gas: 1e6 }).params[0]
        console.log(JSON.stringify(approveHash, null, 2))
        let sigs = '0x'
        for (var j = 0; j < safeThreshold; j++) {
          sigs += "000000000000000000000000" + ownersToSign[j].replace('0x', '') + "0000000000000000000000000000000000000000000000000000000000000000" + "01"
        }
        const safeTx = await safeInstance.execTransaction.request(safeInstance.address, 0, safeTransaction.data, 0, 0, 0, 0, 0, 0, sigs, { gas: 1e6 }).params[0]
        logger.info(`Finally exec the multisig with 1 account:`)
        console.log(JSON.stringify(safeTx, null, 2))
      }
    }

    process.exit(0)


  })
}

module.exports = registerCommand