// Copyright 2020-2022 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: Apache-2.0

import type {AccountId, H256, BlockHash, CodeUploadRequest} from '@polkadot/types/interfaces';
// Gets logger and api
import '@subql/types/dist/global';
import {Bytes} from '@polkadot/types';
import {ContractExecResult, ContractCallRequest} from '@polkadot/types/interfaces/contracts';
export default class SubstrateWasmProvider {
  private contracts = (api.rpc as any).contracts;

  async getStorage(
    address: AccountId | string | Uint8Array,
    key: H256 | string | Uint8Array,
    at?: BlockHash | string | Uint8Array
  ): Promise<string> {
    if (at) logger.warn(`Provided parameter 'at' will not be used`);
    const storage: Bytes = this.contracts.getStorage(address, key);
    return storage.toHex();
  }

  async call(
    callRequest:
      | ContractCallRequest
      | {
          origin?: any;
          dest?: any;
          value?: any;
          gasLimit?: any;
          storageDepositLimit?: any;
          inputData?: any;
        }
      | string
      | Uint8Array,
    at?: BlockHash | string | Uint8Array
  ): Promise<ContractExecResult> {
    if (at) logger.warn(`Provided parameter 'at' will not be used`);
    return this.contracts.call(callRequest);
  }

  instantiate(transactionHash: string, confirmations?: number, timeout?: number) {
    throw new Error('Method `instantiate` not supported.');
  }

  rentProjection(address: AccountId | string | Uint8Array, at?: BlockHash | string | Uint8Array) {
    throw new Error('Method `rentProjection` not supported.');
  }

  uploadCode(
    uploadRequest:
      | CodeUploadRequest
      | {
          origin?: any;
          code?: any;
          storageDepositLimit?: any;
        }
      | string
      | Uint8Array,
    at?: BlockHash | string | Uint8Array
  ) {
    throw new Error('Method `uploadCode` not supported.');
  }
}
