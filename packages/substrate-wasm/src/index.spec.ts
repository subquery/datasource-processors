// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
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
import {u8, Vec} from '@polkadot/types';
import path from 'path';

import {Balance, AccountId} from '@polkadot/types/interfaces/runtime';
import {Option} from '@polkadot/types-codec';
import {DictionaryQueryEntry} from '@subql/types-core';
import axios from 'axios';

type TransferEventArgs = [Option<AccountId>, Option<AccountId>, Balance];

(global as any).logger = new Logger({
  level: 'debug',
  outputFormat: 'colored',
  nestedKey: 'payload',
}).getLogger('WasmTests');

const SHIBUYA_ENDPOINT = 'wss://shibuya-rpc.dwellir.com';
const FLIP_PATH = path.join(process.cwd(), './packages/substrate-wasm/test/flipMetadata.json');
const ERC20_PATH = path.join(process.cwd(), './packages/substrate-wasm/test/erc20Metadata.json');
const MULTISIG_FACTORY_PATH = path.join(process.cwd(), './packages/substrate-wasm/test/multisig_factory.json');

const DICTIONARY_URL = 'https://api.subquery.network/sq/subquery/shiden-dictionary';

const dsTransfer = {
  kind: 'substrate/Wasm',
  processor: {
    file: '',
    options: {
      abi: 'erc20',
      contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
    },
  },
  assets: new Map([['erc20', {file: ERC20_PATH}]]),
} as unknown as WasmDatasource;

const baseDS: WasmDatasource = {
  ...dsTransfer,
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
const dsFlip = {
  kind: 'substrate/Wasm',
  processor: {
    file: '',
    options: {
      abi: 'flip',
      contract: 'Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK',
    },
  },
  assets: new Map([['flip', {file: FLIP_PATH}]]),
} as unknown as WasmDatasource;

const assets = {
  erc20: fs.readFileSync(ERC20_PATH).toString('utf8'),
  flip: fs.readFileSync(FLIP_PATH).toString('utf8'),
  multisig_factory: fs.readFileSync(MULTISIG_FACTORY_PATH).toString('utf8'),
};

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
      const flipAbi = buildAbi(dsFlip, assets);
      const blockNumber = 2105713;
      const {extrinsics} = await fetchBlock(api, blockNumber);
      const decoded = decodeMessage(extrinsics[2].extrinsic.args[4].toU8a(), flipAbi);

      expect(decoded.args).toHaveLength(0);
      expect(decoded.message.identifier).toEqual('flip');
    });

    it('decode event', async function () {
      const erc20Abi = buildAbi(dsTransfer, assets);
      const blockNumber = 2135058;
      const {events} = await fetchBlock(api, blockNumber);
      const decoded = decodeEvent(events[7], erc20Abi);

      expect(decoded?.event.identifier).toBe('Transfer');
      expect(decoded?.args[0].toString()).toBe('5H3Yk49EsYMcZsoZSXqXMuBw7Htp3v1b1QXTKnT7rgXCyoPi');
      expect(decoded?.args[1].toString()).toBe('5FdYHZTPBofcRjRE5jSib6FMXHEkuyDYjQswPTpjt2fso4LY');
      expect(decoded?.args[2].toString()).toBe('0');
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
        assets: new Map([['erc20', {file: ERC20_PATH}]]),
        mapping: {
          handlers: [
            {
              handler: 'handleSubstrateWasmEvent',
              kind: 'substrate/WasmEvent',
            },
          ],
        },
      } as unknown as WasmDatasource;

      // Used to load the ABIs
      WasmDatasourcePlugin.validate(ds, assets);
    });

    describe('Filtering', () => {
      it('check query entity for contractEmitteds', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmEvent'];
        const query = processor.dictionaryQuery?.(
          {
            contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
            identifier: 'Transfer',
          },
          ds
        );

        const response = await axios.post(DICTIONARY_URL, {
          query: `query { ${query?.entity} { nodes {eventIndex} } }`,
          variables: null,
        });
        expect(response.status).toBe(200);
      });
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
          processor.filterProcessor({
            filter: {},
            input: event,
            ds: {
              processor: {options: {contract: '0x0000000000000000000000000000000000000000'}},
              assets: new Map([['erc20', {file: ERC20_PATH}]]),
            } as WasmDatasource,
          })
        ).toBeFalsy();
      });

      it('filters topics', async () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: event,
            ds,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {
              contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
              identifier: 'Transfer',
            },
            input: event,
            ds,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
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
      });
    });

    describe('improve performance', () => {
      it('only decode data once at filtering and transforming', async () => {
        //TODO, spy on decodeEvent
        // const AbiDecodeEventSpy = jest.spyOn(
        //     Abi as any,
        //     `decodeEvent`,
        // );
        processor.filterProcessor({
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
        assets: new Map([['flip', {file: FLIP_PATH}]]),
      } as unknown as WasmDatasource;

      // Used to load the ABIs
      WasmDatasourcePlugin.validate(ds, assets);
    });

    describe('Filtering', () => {
      it('check query entity for contractsCalls', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        ds = {
          kind: 'substrate/Wasm',
          processor: {
            file: '',
            options: {
              abi: 'flip',
              contract: 'Yi7XDNj695kuHY9ZmtH4YWeBrwTFWo6YMi4YnLstvjUVVfK',
            },
          },
          assets: new Map([['flip', {file: FLIP_PATH}]]),
        } as unknown as WasmDatasource;
        const query = processor.dictionaryQuery?.({selector: '0x633aa551'}, ds);

        const response = await axios.post(DICTIONARY_URL, {
          query: `query { ${query?.entity} { nodes {selector} } }`,
          variables: null,
        });
        expect(response.status).toBe(200);
      });
      it('filters matching contract address', async () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
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
          processor.filterProcessor({
            filter: {from: 'b1enkZo2igzkFv9vpkTbZczyketzwPsoeL81cuabx9xyxmh'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {from: '0x0000000000000000000000000000000000000000'},
            input: extrinsic,
            ds,
          })
        ).toBeFalsy();
      });
      it('can filter method', async () => {
        expect(
          processor.filterProcessor({
            filter: {method: 'flip'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {method: 'Transfer'},
            input: extrinsic,
            ds,
          })
        ).toBeFalsy();
      });

      it('can filter selector', async () => {
        expect(
          processor.filterProcessor({
            filter: {selector: '0x633aa551'},
            input: extrinsic,
            ds,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
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
    describe('event query', () => {
      it('get event index from abi json by identifier name', async () => {
        const ds = {
          kind: 'substrate/Wasm',
          processor: {
            file: '',
            options: {
              abi: 'erc20',
              contract: 'a6Yrf6jAPUwjoi5YvvoTE4ES5vYAMpV55ZCsFHtwMFPDx7H',
            },
          },
          assets: new Map([['erc20', {file: ERC20_PATH}]]),
          mapping: {
            handlers: [
              {
                handler: 'handleSubstrateWasmEvent',
                kind: 'substrate/WasmEvent',
              },
            ],
          },
        } as unknown as WasmDatasource;

        expect(getEventIndex('Transfer', ds)).toBe(0);
        expect(getEventIndex('Approval', ds)).toBe(1);
        expect(getEventIndex('Removal', ds)).toBeUndefined();
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
          assets: new Map([['flip', {file: FLIP_PATH}]]),
        } as unknown as WasmDatasource;

        // Used to load the ABIs
        WasmDatasourcePlugin.validate(ds, assets);
      });

      it('get call selector from data', () => {
        //arg 4 is call data
        const data = extrinsic.extrinsic.args[4] as Vec<u8>;
        expect(getSelector(data)).toBe('0x633aa551');
      });

      it('covert method to selector', async () => {
        expect(methodToSelector('flip', ds)).toBe('0x633aa551');
        expect(methodToSelector('undefined', ds)).toBeUndefined();
      });

      it('generate dictionary query with call filters selector', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery?.({selector: '0x633aa551'}, ds);

        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });

      it('generate dictionary query with call filters method', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery?.({method: 'get'}, ds);
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x2f865bd9');
      });

      it('it unique selectors', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery?.({selector: '0x633aa551', method: 'flip'}, ds);
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });

      it('if the selector and method not match, take selector into dictionary query only', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmCall'];
        const query = processor.dictionaryQuery?.({selector: '0x633aa551', method: 'get'}, ds);
        expect(query?.conditions[1].field).toBe('selector');
        expect(query?.conditions[1].value).toBe('0x633aa551');
      });
    });
  });
});

describe('Wasm V4', () => {
  jest.setTimeout(500000);

  let api: ApiPromise;

  beforeAll(async () => {
    api = await ApiPromise.create({
      provider: new WsProvider('wss://rococo-contracts-rpc.polkadot.io'),
      noInitWarn: true,
    });
  });

  afterAll(async () => {
    delete (global as any).logger;
    await api?.disconnect();
  }, 500000);

  describe('dictionary query', () => {
    describe('event query', () => {
      it('generate dictionary query with call filters method', async () => {
        const processor = WasmDatasourcePlugin.handlerProcessors['substrate/WasmEvent'];
        const ds = {
          kind: 'substrate/Wasm',
          processor: {
            file: '',
            options: {
              abi: 'multisig_factory',
              contract: '5HRfJo4TkyLU2Dh8pmaTyU5ynMr94uLv9GYZnRHpsCBiECaC',
            },
          },
          assets: new Map([['multisig_factory', {file: MULTISIG_FACTORY_PATH}]]),
          mapping: {
            handlers: [
              {
                handler: 'handleSubstrateWasmEvent',
                kind: 'substrate/WasmEvent',
              },
            ],
          },
        } as unknown as WasmDatasource;
        WasmDatasourcePlugin.validate(ds, assets);

        const query = processor.dictionaryQuery?.(
          {contract: '5HRfJo4TkyLU2Dh8pmaTyU5ynMr94uLv9GYZnRHpsCBiECaC', identifier: 'NewMultisig'},
          ds
        );
        expect(query?.entity).toBe('contractEmitteds');
        expect(query?.conditions).toStrictEqual([
          {field: 'contract', value: '5hrfjo4tkylu2dh8pmatyu5ynmr94ulv9gyznrhpscbiecac'},
          {field: 'eventIndex', value: '0'},
        ]);
      });
    });
  });
});
