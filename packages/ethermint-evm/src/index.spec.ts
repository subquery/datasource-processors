// Copyright 2020-2025 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0
import {CosmWasmClient} from '@cosmjs/cosmwasm-stargate';
import {Logger} from '@subql/utils';
import {CosmosEvent, CosmosMessage} from '@subql/types-cosmos';
import EthermintEvmDatasourcePlugin, {EthermintEvmCall, EthermintEvmDatasource, EthermintEvmEvent} from '.';

import {fetchBlock, getChainType, processChainTypes} from '../../../test/cosmosHelpers';
import {Registry, GeneratedType} from '@cosmjs/proto-signing';
import {CustomModule} from '@subql/types-cosmos';
import {Tendermint34Client} from '@cosmjs/tendermint-rpc';
const erc20MiniAbi = `[{"type":"event","name":"Approval","inputs":[{"type":"address","name":"src","internalType":"address","indexed":true},{"type":"address","name":"guy","internalType":"address","indexed":true},{"type":"uint256","name":"wad","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"Deposit","inputs":[{"type":"address","name":"dst","internalType":"address","indexed":true},{"type":"uint256","name":"wad","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"Transfer","inputs":[{"type":"address","name":"src","internalType":"address","indexed":true},{"type":"address","name":"dst","internalType":"address","indexed":true},{"type":"uint256","name":"wad","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"event","name":"Withdrawal","inputs":[{"type":"address","name":"src","internalType":"address","indexed":true},{"type":"uint256","name":"wad","internalType":"uint256","indexed":false}],"anonymous":false},{"type":"fallback","stateMutability":"payable","payable":true},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"allowance","inputs":[{"type":"address","name":"","internalType":"address"},{"type":"address","name":"","internalType":"address"}],"constant":true},{"type":"function","stateMutability":"nonpayable","payable":false,"outputs":[{"type":"bool","name":"","internalType":"bool"}],"name":"approve","inputs":[{"type":"address","name":"guy","internalType":"address"},{"type":"uint256","name":"wad","internalType":"uint256"}],"constant":false},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"balanceOf","inputs":[{"type":"address","name":"","internalType":"address"}],"constant":true},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"uint8","name":"","internalType":"uint8"}],"name":"decimals","inputs":[],"constant":true},{"type":"function","stateMutability":"payable","payable":true,"outputs":[],"name":"deposit","inputs":[],"constant":false},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"string","name":"","internalType":"string"}],"name":"name","inputs":[],"constant":true},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"string","name":"","internalType":"string"}],"name":"symbol","inputs":[],"constant":true},{"type":"function","stateMutability":"view","payable":false,"outputs":[{"type":"uint256","name":"","internalType":"uint256"}],"name":"totalSupply","inputs":[],"constant":true},{"type":"function","stateMutability":"nonpayable","payable":false,"outputs":[{"type":"bool","name":"","internalType":"bool"}],"name":"transfer","inputs":[{"type":"address","name":"dst","internalType":"address"},{"type":"uint256","name":"wad","internalType":"uint256"}],"constant":false},{"type":"function","stateMutability":"nonpayable","payable":false,"outputs":[{"type":"bool","name":"","internalType":"bool"}],"name":"transferFrom","inputs":[{"type":"address","name":"src","internalType":"address"},{"type":"address","name":"dst","internalType":"address"},{"type":"uint256","name":"wad","internalType":"uint256"}],"constant":false},{"type":"function","stateMutability":"nonpayable","payable":false,"outputs":[],"name":"withdraw","inputs":[{"type":"uint256","name":"wad","internalType":"uint256"}],"constant":false}]`;

(global as any).logger = new Logger({
  level: 'debug',
  outputFormat: 'colored',
  nestedKey: 'payload',
}).getLogger('EthermintTests');

(global as any).registry = new Registry();

describe('EthermintDS', () => {
  jest.setTimeout(1000000);

  let api: CosmWasmClient;
  let tm: Tendermint34Client;
  let chainTypes: Record<string, GeneratedType>;
  beforeAll(async () => {
    api = await CosmWasmClient.connect('https://rpc-evmos.whispernode.com');
    tm = await Tendermint34Client.connect('https://rpc-evmos.whispernode.com');
    const protos = new Map<string, CustomModule>();
    protos.set('ethermint.evm.v1', {
      file: './proto/ethermint/evm/v1/tx.proto',
      messages: ['MsgEthereumTx', 'LegacyTx', 'AccessListTx', 'DynamicFeeTx'],
    });
    protos.set('ethermint.evm.v12', {
      file: './proto/ethermint/evm/v1/evm.proto',
      messages: ['AccessTuple'],
    });
    protos.set('google.protobuf', {
      file: './proto/google/protobuf/any.proto',
      messages: ['Any'],
    });

    const protoRoots = await processChainTypes(protos);
    chainTypes = await getChainType(protoRoots);
    for (const typeurl in chainTypes) {
      (global as any).registry.register(typeurl, chainTypes[typeurl]);
    }
  });

  afterAll(async () => {
    delete (global as any).logger;
    await api?.disconnect();
  }, 30000);

  describe('FilterValidator', () => {
    const processor = EthermintEvmDatasourcePlugin.handlerProcessors['cosmos/EthermintEvmEvent'];

    describe('EthermintEvmEvent', () => {
      it('validates with no filter', () => {
        expect(() => processor.filterValidator(undefined)).not.toThrow();
      });

      it.skip('validates with only an address', () => {
        // expect(() => processor.filterValidator({address: '0x6bd193ee6d2104f14f94e2ca6efefae561a4334b'})).not.toThrow();
      });

      it('validates with only topics', () => {
        expect(() =>
          processor.filterValidator({
            topics: ['0x6bd193ee6d2104f14f94e2ca6efefae561a4334b', null, undefined, undefined],
          })
        ).not.toThrow();
      });

      // Not supported because of dictionary limitations
      it.skip('validates topics with OR option', () => {
        // expect(() =>
        //   processor.filterValidator({
        //     topics: [
        //       [
        //         '0x6bd193ee6d2104f14f94e2ca6efefae561a4334b',
        //         '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        //       ],
        //     ],
        //   })
        // ).not.toThrow();
      });

      // it('checks the max number of topics', () => {
      //   expect(() => processor.filterValidator({ topics: [null, null, null, null, '0x00'] })).toThrow()
      // });

      it('checks topics are valid hex strings', () => {
        expect(() => processor.filterValidator({topics: ['Hello World', undefined, undefined, undefined]})).toThrow();
      });

      // Not supported because of dictionary limitations
      it.skip('checks OR topics are valid hex strings', () => {
        // expect(() => processor.filterValidator({topics: [['Hello', 'World']]})).toThrow();
      });
    });
  });

  describe('FilterProcessor', () => {
    describe('EthermintEvmEvent', () => {
      const processor = EthermintEvmDatasourcePlugin.handlerProcessors['cosmos/EthermintEvmEvent'];
      let log: CosmosEvent;

      beforeAll(async () => {
        const {events} = await fetchBlock(api, tm, (global as any).registry, 1474211);

        log = events[15];
      });

      it('filters just a matching address', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: log,
            ds: {
              processor: {options: {address: '0xD4949664cD82660AaE99bEdc034a0deA8A0bd517'}},
            } as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      it('filters just a non-matching address', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: log,
            ds: {processor: {options: {address: '0x00'}}} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });

      it('filters topics matching 1', () => {
        expect(
          processor.filterProcessor({
            filter: {topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      it('filters topics matching 2', () => {
        expect(
          processor.filterProcessor({
            filter: {topics: [null, null, '0x0000000000000000000000000bdf933abb0e8c2cd57d67129d3ef75414f7c774']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      it('filters topics matching 3', () => {
        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                null,
                '0x0000000000000000000000000bdf933abb0e8c2cd57d67129d3ef75414f7c774',
              ],
            },
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      // it.skip('filters topics matching 4', () => {
      //   expect(
      //     processor.filterProcessor({
      //       filter: {topics: [['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x00']]},
      //       input: log,
      //       ds: {} as EthermintEvmDatasource,
      //     })
      //   ).toBeTruthy();
      // });

      it('filters topics matching with event', () => {
        expect(
          processor.filterProcessor({
            filter: {topics: ['Transfer(address indexed src, address indexed dst, uint256 wad)']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {topics: ['Transfer(address src, address dst, uint256 wad)']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {topics: ['Transfer(address, address, uint256)']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      it('filters topics NOT matching 1', () => {
        expect(
          processor.filterProcessor({
            filter: {topics: ['0x6bd193ee6d2104f14f94e2ca6efefae561a4334b']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });

      it('filters topics NOT matching 2', () => {
        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                '0x6bd193ee6d2104f14f94e2ca6efefae561a4334b',
                null,
                '0x0000000000000000000000000bdf933abb0e8c2cd57d67129d3ef75414f7c774',
              ],
            },
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });

      it('filters topics without zero padding', () => {
        expect(
          processor.filterProcessor({
            filter: {topics: [null, null, '0xbdf933abb0e8c2cd57d67129d3ef75414f7c774']},
            input: log,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });
    });

    describe('EthermintEvmCall', () => {
      const processor = EthermintEvmDatasourcePlugin.handlerProcessors['cosmos/EthermintEvmCall'];

      let transaction: CosmosMessage;

      beforeAll(async () => {
        const {messages} = await fetchBlock(api, tm, (global as any).registry, 1474211);

        transaction = messages[2];
      });

      it.skip('can filter from', () => {
        expect(
          processor.filterProcessor({
            filter: {from: ''},
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {from: '0x0000000000000000000000000000000000000000'},
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });

      it.skip('can filter contract address', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: transaction,
            ds: {
              processor: {options: {address: '0xD4949664cD82660AaE99bEdc034a0deA8A0bd517'}},
            } as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {},
            input: transaction,
            ds: {
              processor: {options: {address: '0x0000000000000000000000000000000000000000'}},
            } as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });

      /*
      it('can filter for contract creation', async () => {
        const blockNumber = 442090;
        const {extrinsics} = await fetchBlock(api, blockNumber);

        const contractTx = extrinsics[4];
        expect(
          processor.filterProcessor({
            filter: {},
            input: contractTx,
            ds: {processor: {options: {address: null}}} as unknown as EthermintEvmDatasource,
          })
        ).toBeTruthy();
      }, 40000);
      */

      it.skip('can filter function with signature', () => {
        expect(
          processor.filterProcessor({
            filter: {
              method: 'transfer(address dst, uint256 wad)',
            },
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {method: 'transfer(address, uint256)'},
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();
      });

      it.skip('can filter function with method id', () => {
        expect(
          processor.filterProcessor({
            filter: {method: '0xa9059cbb'},
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {method: '0x0000000'},
            input: transaction,
            ds: {} as EthermintEvmDatasource,
            registry: {} as Registry,
          })
        ).toBeFalsy();
      });
    });
  });

  describe('EthermintTransformation', () => {
    const baseDS: EthermintEvmDatasource = {
      kind: 'cosmos/EthermintEvm',
      assets: new Map([['erc20', {file: erc20MiniAbi}]]),
      processor: {
        file: '',
        options: {
          abi: 'erc20',
        },
      },
      mapping: {
        file: '',
        handlers: [
          {
            kind: 'cosmos/EthermintEvmCall',
            filter: {},
            handler: 'imaginaryHandler',
          },
        ],
      },
    };

    describe('EthermintEvmEvents', () => {
      const processor = EthermintEvmDatasourcePlugin.handlerProcessors['cosmos/EthermintEvmEvent'];

      it('can transform an event', async () => {
        // https://moonriver.subscan.io/block/717200
        // https://blockscout.moonriver.moonbeam.network/blocks/717200/transactions
        const blockNumber = 1474211;
        const {events} = await fetchBlock(api, tm, (global as any).registry, blockNumber);

        const [event] = (await processor.transformer({
          input: events[15],
          ds: baseDS,
          api,
          assets: {erc20: erc20MiniAbi},
        })) as [EthermintEvmEvent];

        expect(event.address).toBe('0xD4949664cD82660AaE99bEdc034a0deA8A0bd517');
        expect(event.transactionIndex).toBe(0);
        expect(event.transactionHash).toBe('0x4a2ed69f1140f66fc0cbef53757d99d77d959bdd867d7ac3d1aea5176910df62');
        expect(event.logIndex).toBe(0);
        expect(event.blockNumber).toBe(blockNumber);
        expect(event.data).toBe('0x0000000000000000000000000000000000000000000000019bc103cd35d70000');
        expect(event.topics[0]).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
        expect(event.topics[1]).toBe('0x000000000000000000000000e59e56cce16921367ce87382204db568879f7724');
        expect(event.topics[2]).toBe('0x0000000000000000000000000bdf933abb0e8c2cd57d67129d3ef75414f7c774');

        if (event.args) {
          expect(event.args[0]).toBe('0xe59e56cce16921367CE87382204dB568879f7724');
          expect(event.args[1]).toBe('0x0BDF933aBb0E8c2Cd57d67129D3EF75414F7C774');
          expect(JSON.parse(event.args[2])).toBe(29670000000000000000);
        }
      });
    });

    describe('EthermintEvmCalls', () => {
      const processor = EthermintEvmDatasourcePlugin.handlerProcessors['cosmos/EthermintEvmCall'];

      it.skip('can transform a contract tx', async () => {
        // https://moonriver.subscan.io/block/717200
        // https://blockscout.moonriver.moonbeam.network/blocks/717200/transactions
        const blockNumber = 1474211;
        const {messages} = await fetchBlock(api, tm, (global as any).registry, blockNumber);

        const [call] = (await processor.transformer({input: messages[2], ds: baseDS, api})) as [EthermintEvmCall];

        expect(call.from).toBe('');
        expect(call.to).toBe('0xD4949664cD82660AaE99bEdc034a0deA8A0bd517');
        expect(call.nonce).toBe(204);
        expect(call.data).toBe(
          '0xe2bbb15800000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000'
        );
        expect(call.hash).toBe(
          '0xa9059cbb0000000000000000000000000bdf933abb0e8c2cd57d67129d3ef75414f7c7740000000000000000000000000000000000000000000000019bc103cd35d70000'
        );
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeTruthy();

        // Signature values
        expect(call.r).toBeDefined();
        expect(call.s).toBeDefined();
        expect(call.v).toBeDefined();

        // expect(call.blockHash).toBe('0x7399a701a5827d2cf0365d94ab1d0c1864d7fe3f41c316dc283e86e87b372ce8');

        // TODO setup abi/interface passing
      });

      it.skip('can transform a transfer tx', async () => {
        // https://www.mintscan.io/evmos/txs/7EA309D5AE839B1933F31405F58F004679B4653711A884BC5D5C9D5CADD17846

        const blockNumber = 1810664;
        const {messages} = await fetchBlock(api, tm, (global as any).registry, blockNumber);

        const [call] = (await processor.transformer({input: messages[0], ds: baseDS, api})) as [EthermintEvmCall];

        expect(call.from).toBe('');
        expect(call.to).toBe('0xC2871545088781378c6F3C27A732733C8b30B1dA');
        expect(call.nonce).toBe(2552);
        expect(call.data).toBe(
          '0x426df94e977d82d917a621dff75c00abd19a27c26b26f251e44ffad5c2b122c8b635671fcc8139dc636e82c3edbd08ebe51cb5e824ecd1df6aafaead3bee4726fcd4949664cd82660aae99bedc034a0dea8a0bd5170000000000000000000000004afb8cf417a8fbec0daf0000000001'
        );
        expect(call.hash).toBe('0x234360bbf301156543ada1c2b230439f111b1d420933927f0307f8cec888cc66');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeTruthy();
        expect(call.value.toString()).toBe('0');

        // Signature values
        expect(call.r).toBeDefined();
        expect(call.s).toBeDefined();
        expect(call.v).toBeDefined();

        // expect(call.blockHash).toBe('0xaadd85c55f7f8c31140f38b840cf269cdc230a8b7d8057366fbeb3a22c6de0f9');
      });

      it.skip('can transform a failed tx', async () => {
        // https://moonriver.subscan.io/block/829253
        // https://blockscout.moonriver.moonbeam.network/blocks/829253/transactions

        const blockNumber = 1810791;
        const {messages} = await fetchBlock(api, tm, (global as any).registry, blockNumber);
        const [call] = (await processor.transformer({input: messages[0], ds: baseDS, api})) as [EthermintEvmCall];

        expect(call.from).toBe('');
        expect(call.to).toBe('0x5cf1bfd3d3e5c82d2c482211873299da1747b0ba');
        expect(call.nonce).toBe(10701);
        expect(call.data).toBe('0x4641257d');
        expect(call.hash).toBe('0x5456c6e0af69c35ccdaf171ce1625eb3615d4d9ab002fbdd57a3483771d8a76f');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeFalsy();

        // expect(call.blockHash).toBe('0xaadd85c55f7f8c31140f38b840cf269cdc230a8b7d8057366fbeb3a22c6de0f9');
      });
    });
  });
});
