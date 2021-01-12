import { vap as LedgerVaporyApi } from "ledgerco";

import { LedgerConnectionFactory } from "./connection-factories";
import { ErrorWithCode, WrappedError, ErrorCode } from "./errors";
import { LockingLedgerConnection } from "./locking-ledger-connection";
import { Network } from "./network";
import { Signature } from "./signature";

export class LedgerVapory {
	private network: Network;
	private connectLedgerRequest: () => Promise<void>;
	private openVaporyAppRequest: () => Promise<void>;
	private switchLedgerModeRequest: () => Promise<void>;
	private enableContractSupportRequest: () => Promise<void>;
	private lockingLedgerConnection: LockingLedgerConnection;

	constructor(
		network: Network,
		ledgerConnectionFactory: LedgerConnectionFactory,
		connectLedgerRequest: () => Promise<void>,
		openVaporyAppRequest: () => Promise<void>,
		switchLedgerModeRequest: () => Promise<void>,
		enableContractSupportRequest: () => Promise<void>,
	) {
		this.network = network;
		this.lockingLedgerConnection = new LockingLedgerConnection(ledgerConnectionFactory);
		this.connectLedgerRequest = connectLedgerRequest;
		this.openVaporyAppRequest = openVaporyAppRequest;
		this.switchLedgerModeRequest = switchLedgerModeRequest;
		this.enableContractSupportRequest = enableContractSupportRequest;
	}

	// TODO: deal with timeouts

	public getAddressByBip44Index = async (index: number = 0): Promise<string> => {
		const bip32Path = this.bip44IndexToBip32Path(index);
		return await this.getAddressByBip32Path(bip32Path);
	}

	public getAddressByBip32Path = async (path: string): Promise<string> => {
		return await this.lockingLedgerConnection.safelyCallVaporyApi(async ledgerVaporyApi => {
			return await this.callLedgerWithErrorHandling(ledgerVaporyApi, async api => {
				const publicKeyAndAddress = await ledgerVaporyApi.getAddress_async(path);
				return publicKeyAndAddress.address;
			});
		});
	}

	public signTransactionByBip44Index = async (hexEncodedTransaction: string, index: number = 0): Promise<Signature> => {
		const bip32Path = this.bip44IndexToBip32Path(index);
		return await this.signTransactionByBip32Path(hexEncodedTransaction, bip32Path);
	}

	public signTransactionByBip32Path = async (hexEncodedTransaction: string, path: string = this.bip44IndexToBip32Path(0)): Promise<Signature> => {
		if (!/^[0-9a-fA-F]*$/.test(hexEncodedTransaction)) throw new ErrorWithCode(`Transaction must be a byte array hex encoded into a string.  Received ${hexEncodedTransaction}`, ErrorCode.InvalidInput);
		return await this.lockingLedgerConnection.safelyCallVaporyApi(async ledgerVaporyApi => {
			return await this.callLedgerWithErrorHandling(ledgerVaporyApi, async api => {
				const signature = await ledgerVaporyApi.signTransaction_async(path, hexEncodedTransaction);
				return Signature.fromSignature(signature);
			});
		});
	}

	private callLedgerWithErrorHandling = async <T>(api: LedgerVaporyApi, func: (api: LedgerVaporyApi) => Promise<T>): Promise<T> => {
		try {
			return await func(api);
		} catch (error) {
			if (error === "No device found") {
				await this.connectLedgerRequest();
				return await this.callLedgerWithErrorHandling(api, func);
			} else if (error === "Invalid status 6d00" || error === "Invalid status 6700") {
				await this.openVaporyAppRequest();
				return await this.callLedgerWithErrorHandling(api, func);
			} else if (error === "Invalid channel;") {
				await this.switchLedgerModeRequest();
				return await this.callLedgerWithErrorHandling(api, func);
			} else if (error === "Invalid status 6a80") {
				await this.enableContractSupportRequest();
				return await this.callLedgerWithErrorHandling(api, func);
			} else if (error === "Invalid status 6804") {
				throw new ErrorWithCode("Security Exception.  This likely means you provided an invalid BIP32 path.  Do you have hardening in the right places?", ErrorCode.BadRequest);
			} else if (error && error.errorCode === 2) {
				const betterError = new ErrorWithCode("Bad Request.  This likely means you are trying to use u2f from a webpage served by HTTP (instead of HTTPS).", ErrorCode.BadRequest);
				betterError.stack = error.stack;
				throw betterError;
			} else if (error && error.errorCode === 5) {
				await this.connectLedgerRequest();
				return await this.callLedgerWithErrorHandling(api, func);
			} else if (error instanceof Error && error.message === "Invalid hex string") {
				const betterError = new ErrorWithCode("Invalid input", ErrorCode.InvalidInput);
				betterError.stack = error.stack;
				throw betterError;
			} else {
				throw new WrappedError("Unknown error from ledger (see data).", error);
			}
		}
	}

	// FIMXE: change to `m/44'/${this.network}'/0'/0/${index}` after https://github.com/LedgerHQ/blue-app-eth/issues/2 is fixed.
	private bip44IndexToBip32Path = (index: number) => `m/44'/60'/0'/0/${index}`;
}
