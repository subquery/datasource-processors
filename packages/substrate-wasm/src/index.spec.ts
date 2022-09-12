// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {ApiPromise, WsProvider} from '@polkadot/api';
import {Logger} from '@subql/utils';
import {SubstrateEvent, SubstrateExtrinsic} from '@subql/types';

import WasmDatasourcePlugin, {
  buildAbi,
  decodeMessage,
  decodeEvent,
  WasmCall,
  WasmDatasource,
  WasmEvent,
  getEventIndex,
  getSelector,
  methodToSelector,
  ContractEmittedResult,
  ContractCallArgs,
} from './index';

import {fetchBlock} from '../../../test/helpers';
import {Bytes, u8, Vec} from '@polkadot/types';
import path from 'path';

import {Balance, AccountId} from '@polkadot/types/interfaces/runtime';
import {Option} from '@polkadot/types-codec';
import {DictionaryQueryEntry} from '@subql/types/dist/project';

type TransferEventArgs = [Option<AccountId>, Option<AccountId>, Balance];

(global as any).logger = new Logger({
  level: 'debug',
  outputFormat: 'colored',
  nestedKey: 'payload',
}).getLogger('WasmTests');

const baseDS: WasmDatasource = {
  kind: 'substrate/Wasm',
  processor: {
    file: '',
    options: {
      abi: 'erc20',
      contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
    },
  },
  assets: new Map([['erc20', {file: path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json')}]]),
  mapping: {
    file: '',
    handlers: [
      {
        kind: 'substrate/WasmCall',
        filter: {},
        handler: 'imaginaryHandler',
      },
    ],
  },
};

const SHIBUYA_ENDPOINT = 'wss://public-rpc.pinknode.io/shibuya';

const dsTransfer = {
  kind: 'substrate/Wasm',
  processor: {
    file: '',
    options: {
      abi: 'erc20',
      contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
    },
  },
  assets: new Map([['erc20', {file: path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json')}]]),
} as unknown as WasmDatasource;
const dsFlip = {
  kind: 'substrate/Wasm',
  processor: {
    file: '',
    options: {
      abi: 'flip',
      contract: 'Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK',
    },
  },
  assets: new Map([['flip', {file: path.join(process.cwd(), './packages/substrate-wasm/test/flipMetadata.json')}]]),
} as unknown as WasmDatasource;

describe('WasmDS', () => {
  jest.setTimeout(500000);

  let api: ApiPromise;

  beforeAll(async () => {
    api = await ApiPromise.create({
      provider: new WsProvider(SHIBUYA_ENDPOINT),
      // typesBundle: typesBundle as any,
      noInitWarn: true,
    });
  });

  afterAll(async () => {
    delete (global as any).logger;
    await api?.disconnect();
  }, 500000);

  describe('basic decode', () => {
    it('decode message', async function () {
      const flipAbi = await buildAbi(dsFlip);
      const blockNumber = 2105713;
      const {extrinsics} = await fetchBlock(api, blockNumber);
      const decoded = decodeMessage(extrinsics[2].extrinsic.args[4].toU8a(), flipAbi);
      console.log(decoded);
    });
    it('decode event', async function () {
      const erc20Abi = await buildAbi(dsTransfer);
      const blockNumber = 2135058;
      const {events} = await fetchBlock(api, blockNumber);
      const {
        event: {
          data: [, data],
        },
      } = events[7];
      const decoded = decodeEvent(data as Bytes, erc20Abi);
      console.log(decoded?.event.args);
      expect(decoded?.event.identifier).toBe('Transfer');
    });
  });

  describe('WasmEvent', () => {
    const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmEvent'];
    let event: SubstrateEvent<ContractEmittedResult>;
    let ds: WasmDatasource;
    beforeEach(async () => {
      const blockNumber = 2135058;
      const {events} = await fetchBlock(api, blockNumber);

      event = events[7] as SubstrateEvent<ContractEmittedResult>;

      ds = {
        kind: 'substrate/Wasm',
        processor: {
          file: '',
          options: {
            abi: 'erc20',
            contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
          },
        },
        assets: new Map([
          ['erc20', {file: path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json')}],
        ]),
        mapping: {
          handlers: [
            {
              handler: 'handleSubstrateWasmEvent',
              kind: 'substrate/WasmEvent',
            },
          ],
        },
      } as unknown as WasmDatasource;
    });

    describe('Filtering', () => {
      it('filters matching contract address', async () => {
        // expect(
        //   processor.filterProcessor({
        //     filter: {},
        //     input: event,
        //     ds: {
        //       processor: {options: {contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H'}},
        //     } as WasmDatasource,
        //   })
        // ).toBeTruthy();

        expect(
          await processor.filterProcessor({
            filter: {},
            input: event,
            ds: {
              processor: {options: {contract: '0x0000000000000000000000000000000000000000'}},
              assets: new Map([
                ['erc20', {file: path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json')}],
              ]),
            } as WasmDatasource,
          })
        ).toBeFalsy();
      });

      it('filters topics', async () => {
        expect(
          await processor.filterProcessor({
            filter: {},
            input: event,
            ds,
          })
        ).toBeTruthy();
        expect(
          await processor.filterProcessor({
            filter: {
              contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
              identifier: 'Transfer',
            },
            input: event,
            ds,
          })
        ).toBeTruthy();
        expect(
          await processor.filterProcessor({
            filter: {identifier: '0x6bd193ee6d2104f14f94e2ca6efefae561a4334b'},
            input: event,
            ds,
          })
        ).toBeFalsy();
      });
    });

    describe('Transforming', () => {
      it('can transform a contract event', async () => {
        //https://shibuya.subscan.io/extrinsic/2135058-2?event=2135058-7
        const blockNumber = 2135058;
        const {events} = await fetchBlock(api, blockNumber);

        const [event] = (await processor.transformer({
          input: events[7] as SubstrateEvent<ContractEmittedResult>,
          filter: {
            contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
          },
          ds: baseDS,
          api,
        })) as [WasmEvent<TransferEventArgs>];
        expect(event.from).toBe('av9BM7KemzinhqPvqHePZMDCLbw28iL2c2bZVeyj3XAa5T6');
        expect(event.contract.toString()).toBe('a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H');
        expect(event.identifier).toBe('Transfer');
        if (event.args) {
          console.log(event.args[2].toHuman());
        }
      });
    });

    describe('improve performance', () => {
      it('only decode data once at filtering and transforming', async () => {
        //TODO, spy on decodeEvent
        // const AbiDecodeEventSpy = jest.spyOn(
        //     Abi as any,
        //     `decodeEvent`,
        // );
        await processor.filterProcessor({
          filter: {
            contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
            identifier: 'Transfer',
          },
          input: event,
          ds,
        });
        await processor.transformer({
          input: event,
          filter: {
            contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
          },
          ds: baseDS,
          api,
        });
        // expect(AbiDecodeEventSpy).toHaveBeenCalledTimes(1)
      });
    });
  });

  describe('WasmCall', () => {
    const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
    let extrinsic: SubstrateExtrinsic<ContractCallArgs>;

    let ds: WasmDatasource;
    //https://shibuya.subscan.io/extrinsic/2105713-2
    beforeEach(async () => {
      const blockNumber = 2105713;
      const {extrinsics} = await fetchBlock(api, blockNumber);
      extrinsic = extrinsics[2] as SubstrateExtrinsic<ContractCallArgs>;
      ds = {
        kind: 'substrate/Wasm',
        processor: {
          file: '',
          options: {
            abi: 'flip',
            contract: 'Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK',
          },
        },
        assets: new Map([
          ['flip', {file: path.join(process.cwd(), './packages/substrate-wasm/test/flipMetadata.json')}],
        ]),
      } as unknown as WasmDatasource;
    });

    describe('Filtering', () => {
      it('filters matching contract address', async () => {
        expect(
          await processor.filterProcessor({
            filter: {},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();

        expect(
          await processor.filterProcessor({
            filter: {},
            input: extrinsic,
            ds: {
              processor: {options: {contract: '0x0000000000000000000000000000000000000000'}},
            } as WasmDatasource,
          })
        ).toBeFalsy();
      });

      it('can filter from', async () => {
        expect(
          await processor.filterProcessor({
            filter: {from: 'b1enkZo2igzkFv9vpkTbZczyketzwPsoeL81cuabx9xyxmh'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          await processor.filterProcessor({
            filter: {from: '0x0000000000000000000000000000000000000000'},
            input: extrinsic,
            ds,
          })
        ).toBeFalsy();
      });
      it('can filter method', async () => {
        expect(
          await processor.filterProcessor({
            filter: {method: 'flip'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          await processor.filterProcessor({
            filter: {method: 'Transfer'},
            input: extrinsic,
            ds,
          })
        ).toBeFalsy();
      });

      it('can filter selector', async () => {
        expect(
          await processor.filterProcessor({
            filter: {selector: '0x633aa551'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          await processor.filterProcessor({
            filter: {selector: '0x2f865bd9'},
            input: extrinsic,
            ds,
          })
        ).toBeFalsy();
      });
    });

    describe('Transforming', () => {
      //https://shibuya.subscan.io/extrinsic/2105713-2
      it('can transform a call tx', async () => {
        const blockNumber = 2105713;
        const {extrinsics} = await fetchBlock(api, blockNumber);
        const extrinsic = extrinsics[2] as SubstrateExtrinsic<ContractCallArgs>;
        const [call] = (await processor.transformer({input: extrinsic, ds: baseDS, api})) as [WasmCall];
        expect(call.from.toString()).toBe('b1enkZo2igzkFv9vpkTbZczyketzwPsoeL81cuabx9xyxmh');
        expect(call.hash).toBe('0x7b3145b136733bfe7fb104da2ba8f2b8948a914d66db62a2756cfda0241c66a3');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeTruthy();
        expect(call.value.toString()).toBe('0');
        expect(call.gasLimit.toString()).toBe('9375000000');
        expect(call.dest.toString()).toBe('Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK');
        if (typeof call.data !== 'string') {
          expect(call.data.message.identifier).toBe('flip');
        } else {
          expect(call.data).toBe('0x633aa551');
        }
      });

      it('can transform a failed call tx', async () => {
        // https://shibuya.subscan.io/extrinsic/2143623-2
        const blockNumber = 2143623;
        const {extrinsics} = await fetchBlock(api, blockNumber);
        const [call] = (await processor.transformer({
          input: extrinsics[2] as SubstrateExtrinsic<ContractCallArgs>,
          ds: baseDS,
          api,
        })) as [WasmCall];
        expect(call.from.toString()).toBe('Yf8MC8aUu6kMS6SdR9VkCr7PN5UCna42BUGoFyvmfrZEf1R');
        expect(call.hash).toBe('0x33d28683f9e43c70847f02eb0aa3247fc54e6db6f8359fe439fa9cf829d1d475');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeFalsy();
        expect(call.value.toString()).toBe('11');
        expect(call.gasLimit.toString()).toBe('1');
        expect(call.dest.toString()).toBe('WtXrR9djhQVtyFAyLe2Yk6cNVr7mTzGsrRjBkrWNDKfZLTG');
        expect(call.data).toBe('0x1234');
      });
    });
  });

  describe('dictionary query', () => {
    let extrinsic: SubstrateExtrinsic;

    describe('event query', () => {
      it('get event index from abi json by identifier name', async () => {
        const blockNumber = 2135058;
        const {extrinsics} = await fetchBlock(api, blockNumber);
        extrinsic = extrinsics[7];
        const ds = {
          kind: 'substrate/Wasm',
          processor: {
            file: '',
            options: {
              abi: 'erc20',
              contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
            },
          },
          assets: new Map([
            ['erc20', {file: path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json')}],
          ]),
          mapping: {
            handlers: [
              {
                handler: 'handleSubstrateWasmEvent',
                kind: 'substrate/WasmEvent',
              },
            ],
          },
        } as unknown as WasmDatasource;

        expect(await getEventIndex('Transfer', ds)).toBe(0);

        expect(await getEventIndex('Approval', ds)).toBe(1);

        expect(await getEventIndex('Removal', ds)).toBeUndefined();
      });
    });

    describe('call query', () => {
      let extrinsic: SubstrateExtrinsic;
      let ds: WasmDatasource;

      beforeAll(async () => {
        const blockNumber = 2105713;
        const {extrinsics} = await fetchBlock(api, blockNumber);
        extrinsic = extrinsics[2];
        ds = {
          kind: 'substrate/Wasm',
          processor: {
            file: '',
            options: {
              abi: 'flip',
              contract: 'Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK',
            },
          },
          assets: new Map([
            ['flip', {file: path.join(process.cwd(), './packages/substrate-wasm/test/flipMetadata.json')}],
          ]),
        } as unknown as WasmDatasource;
      });

      it('get call selector from data', () => {
        //arg 4 is call data
        const data = extrinsic.extrinsic.args[4] as Vec<u8>;
        expect(getSelector(data)).toBe('0x633aa551');
      });

      it('covert method to selector', async () => {
        expect(await methodToSelector('flip', ds)).toBe('0x633aa551');
        expect(await methodToSelector('undefined', ds)).toBeUndefined();
      });

      it('generate dictionary query with call filters selector', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery
          ? await processor.dictionaryQuery({selector: '0x633aa551'}, ds)
          : undefined;

        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });

      it('generate dictionary query with call filters method', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery ? await processor.dictionaryQuery({method: 'get'}, ds) : undefined;
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x2f865bd9');
      });

      it('it unique selectors', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery
          ? await processor.dictionaryQuery({selector: '0x633aa551', method: 'flip'}, ds)
          : undefined;
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });

      it('if the selector and method not match, take selector into dictionary query only', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query: DictionaryQueryEntry | undefined = processor.dictionaryQuery
          ? await processor.dictionaryQuery({selector: '0x633aa551', method: 'get'}, ds)
          : undefined;
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });
    });
  });
});
