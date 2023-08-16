// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {ApiPromise, WsProvider} from '@polkadot/api';
import {Logger} from '@subql/utils';
import {SubstrateEvent, SubstrateExtrinsic} from '@subql/types';

import AcalaEvmDatasourcePlugin, {AcalaEvmCall, AcalaEvmDatasource, AcalaEvmEvent} from '.';

(global as any).logger = new Logger({
  level: 'debug',
  outputFormat: 'colored',
  nestedKey: 'payload',
}).getLogger('AcalaTests');

const baseDS: AcalaEvmDatasource = {
  kind: 'substrate/AcalaEvm',
  assets: new Map(/*[['erc20', {file: erc20MiniAbi}]]*/),
  processor: {
    file: '',
  },
  mapping: {
    file: '',
    handlers: [
      {
        kind: 'substrate/AcalaEvmCall',
        filter: {},
        handler: 'imaginaryHandler',
      },
    ],
  },
};

const MANDALA_ENDPOINT = 'wss://acala-polkadot.api.onfinality.io/public-ws';

import {fetchBlock} from '../../../test/helpers';

describe('AcalaDS', () => {
  jest.setTimeout(100000);

  let api: ApiPromise;

  beforeAll(async () => {
    api = await ApiPromise.create({
      provider: new WsProvider(MANDALA_ENDPOINT),
      // typesBundle: typesBundle as any,
      noInitWarn: true,
    });
  });

  afterAll(async () => {
    delete (global as any).logger;
    await api?.disconnect();
  }, 30000);

  describe('AcalaEvmEvent', () => {
    const processor = AcalaEvmDatasourcePlugin.handlerProcessors['substrate/AcalaEvmEvent'];

    describe('Filtering', () => {
      let event: SubstrateEvent;

      beforeEach(async () => {
        // https://acala.subscan.io/event?block=3653194
        const blockNumber = 3653194;
        const {events} = await fetchBlock(api, blockNumber);

        event = events[9];
      });

      it('filters matching address', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: event,
            ds: {
              processor: {options: {address: '0x54a37a01cd75b616d63e0ab665bffdb0143c52ae'}},
            } as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {},
            input: event,
            ds: {
              processor: {options: {address: '0x0000000000000000000000000000000000000000'}},
            } as AcalaEvmDatasource,
          })
        ).toBeFalsy();
      });

      it('filters topics', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']},
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {topics: ['Transfer(address indexed from, address indexed to, uint256 value)']},
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {topics: ['Transfer(address from, address to, uint256 value)']},
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {topics: ['0x6bd193ee6d2104f14f94e2ca6efefae561a4334b']},
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeFalsy();
      });

      it('filters multiple topics', () => {
        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                'Transfer(address from, address to, uint256 value)',
                '0x00000000000000000000000074ba7d26e977dae79cfeb7c53376cdc699c2f40e',
              ],
            },
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                'Transfer(address from, address to, uint256 value)',
                '0x00000000000000000000000074ba7d26e977dae79cfeb7c53376cdc699c2f40e',
                '0x0000000000000000000000008f6cb1db5a3117c84d3a101ee6d473eecc27ad9c',
              ],
            },
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                'Transfer(address from, address to, uint256 value)',
                null,
                '0x0000000000000000000000008f6cb1db5a3117c84d3a101ee6d473eecc27ad9c',
              ],
            },
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {
              topics: [
                'Transfer(address from, address to, uint256 value)',
                '0x74ba7d26e977dae79cfeb7c53376cdc699c2f40e',
                '0x8f6cb1db5a3117c84d3a101ee6d473eecc27ad9c',
              ],
            },
            input: event,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();
      });

      it('filters with multiple events', async () => {
        const blockNumber = 3646809;
        const {events} = await fetchBlock(api, blockNumber);
        const evt = events[10];

        expect(
          processor.filterProcessor({
            filter: {topics: ['0x6eb224fb001ed210e379b335e35efe88672a8ce935d981a6896b27ffdf52a3b2']},
            input: evt,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();
      });
    });

    describe('Transforming', () => {
      it('can transform a call tx', async () => {
        // https://acala.subscan.io/event?block=3653194
        const blockNumber = 3653194;
        const {events} = await fetchBlock(api, blockNumber);

        const [event] = (await processor.transformer({input: events[9], ds: baseDS, api})) as [AcalaEvmEvent];

        expect(event.address).toBe('0x54a37a01cd75b616d63e0ab665bffdb0143c52ae');
        expect(event.transactionIndex).toBe(2);
        expect(event.transactionHash).toBe('0x6dd1a162a80fca80852a197d444189b74b1711fc63ccd6a14a8536ace32ac358');
        expect(event.logIndex).toBe(0);
        expect(event.blockNumber).toBe(blockNumber);
        expect(event.data).toBe('0x0000000000000000000000000000000000000000000001cffe1148ae04ab0000');
        expect(event.topics[0]).toBe('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');

        // TODO
        // expect(event.args.from).toBe('0x4467a4b51f507083cccbf06dd28097848506d56b');
        // expect(event.args.to).toBe('0xf884c8774b09b3302f98e38C944eB352264024F8');
        // expect(event.args.value.toString()).toBe('0');
      });

      it('can transform relevant logs', async () => {
        // https://acala.subscan.io/event?block=3653194
        const blockNumber = 3653194;
        const {events} = await fetchBlock(api, blockNumber);
        const evt = events[9];

        const transformed = (await processor.transformer({
          input: evt,
          ds: baseDS,
          filter: {topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']},
          api,
        })) as AcalaEvmEvent[];

        expect(transformed.length).toEqual(1);
      });
    });
  });

  describe('AcalaEvmCall', () => {
    const processor = AcalaEvmDatasourcePlugin.handlerProcessors['substrate/AcalaEvmCall'];

    describe('Filtering', () => {
      let extrinsic: SubstrateExtrinsic;

      beforeEach(async () => {
        // https://blockscout.acala.network/tx/0xb457e95d56f41e0868bbea3f0ab1067bcfe6a2c6dd0d33154373cca7e63acdcc
        // https://acala.subscan.io/extrinsic/3608676-2
        const blockNumber = 3608676;
        const {extrinsics} = await fetchBlock(api, blockNumber);

        extrinsic = extrinsics[2];
      });

      it('filters matching address', () => {
        expect(
          processor.filterProcessor({
            filter: {},
            input: extrinsic,
            ds: {
              processor: {options: {address: '0x2a2569e3ae66d4f4b76577f27bd597ca601f94f3'}},
            } as AcalaEvmDatasource,
          })
        ).toBeTruthy();

        expect(
          processor.filterProcessor({
            filter: {},
            input: extrinsic,
            ds: {
              processor: {options: {address: '0x0000000000000000000000000000000000000000'}},
            } as AcalaEvmDatasource,
          })
        ).toBeFalsy();
      });

      it('can filter from', () => {
        expect(
          processor.filterProcessor({
            filter: {from: '0x9cd48be8bf088fb02910669295097784f1f129f5'},
            input: extrinsic,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {from: '0x0000000000000000000000000000000000000000'},
            input: extrinsic,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeFalsy();
      });

      it('can filter function with signature', () => {
        expect(
          processor.filterProcessor({
            filter: {function: 'mint(address account_, uint256 amount_)'},
            input: extrinsic,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeTruthy();
        expect(
          processor.filterProcessor({
            filter: {function: 'transfer(address to, address from)'},
            input: extrinsic,
            ds: {} as AcalaEvmDatasource,
          })
        ).toBeFalsy();
      });
    });

    describe('Transforming', () => {
      it('can transform a call tx', async () => {
        // https://blockscout.acala.network/tx/0xeb9b47741968b1531b0ae63b597bc2b8e378294c5e00f1e2de41ac7d71fb275c
        // https://acala-testnet.subscan.io/extrinsic/3649977-2
        const blockNumber = 3649977;
        const {extrinsics} = await fetchBlock(api, blockNumber);

        const [call] = (await processor.transformer({input: extrinsics[3], ds: baseDS, api})) as [AcalaEvmCall];

        expect(call.from).toBe('0x99537d82f6f4aad1419dd14952b512c7959a2904');
        expect(call.to).toBe('0x219fa396ae50f789b0ce5e27d6ecbe6b36ef49d9');
        expect(call.nonce).toBe(239);
        expect(call.data).toBe(
          '0xdd5b769e907f61cb3d6573ae64327f70ef655ab9d79d2254ec4b814adc93ea0aa589d10a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005e00000000000000000000000000000000000000000000000000000000003794e8000000000000000000000000000000000000000000000000000000000037b108'
        );
        expect(call.hash).toBe('0xeb9b47741968b1531b0ae63b597bc2b8e378294c5e00f1e2de41ac7d71fb275c');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeTruthy();
        expect(call.value.toString()).toBe('0');

        expect(call.gasLimit.toString()).toBe('800000');
        // TODO test gas price
        // expect(call.gasPrice.toString()).toBe('1297652498616');

        // TODO test abi parsing
      });

      it('can transform a failed call tx', async () => {
        // https://blockscout.acala.network/tx/0x70f0573ee82a0856db7ce842ffccb189ae9558d98c78e960d5f78ab6586857db
        // hhttps://acala.subscan.io/extrinsic/3493180-2
        const blockNumber = 3493180;
        const {extrinsics} = await fetchBlock(api, blockNumber);

        const [call] = (await processor.transformer({input: extrinsics[2], ds: baseDS, api})) as [AcalaEvmCall];

        expect(call.from).toBe('0x71571c42067900bfb7ca8b51fccc07ef77074aea');
        expect(call.to).toBe('0xae9d7fe007b3327aa64a32824aaac52c42a6e624');
        expect(call.nonce).toBe(0);
        expect(call.data).toBe(
          '0xe8059810000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000003f701000000030d00c4e1e0ae091710506c437ea97919d74cd5b72bf8b79dfbbefdd8f9d0c76cdca84fe4ca9afc134d8e648289e841366f7d1681ebfe59365ace294c64e5989646640101fe8c1bfa002d2920dae5648fad7ad66f3adbfed739701f1c921181d9d32064a10eb0d0543cf57aa0876f0c22138776201a2da206daeb8d3a0c14901dfeef186a0002d1126ae30941345aba040191e1eec02d1a4a38cfaad49680bc76c22caff3e9121ec045eea9e81773b81f1faaead95dff899e49fc0c1570b969bccc065d8232260003688767f607a5dcf33303d39ebb60bde84f10078443218d2d5412a0fe7fb057975b10ba13c304a2342e9c679f087972e412357c8932c80bc07a126f255488710d010449344592ae31cec9a242b874e4b07d589d64d29dbdd7c5f24340a83f56fe50ef7361d1a5f109ce71703df0db2a21a2fc349bd477e29edf2e2208cc620e4f9c3d01064c00c8b5f458e02184b4e6946f7ae784fdbc4ec72f6db313984a59f4322c10bf0112d59aa56c1da78ed6656efdc33d4225b189e4551235669ec128b8db59d2fe010a249d64004de519de31c4c36ffcb3c775b55eb4ce6291154254b4e771bf110abc0168c19640c514489a703e0c51eadf7def019e3b05874c06d43d1f47031bdbdd000be2c81a9f6aa0a32cf2156b0abae2b6a9872f9b931f5073610c07aa7b4d1803e216c6d2c13a6b4bce6315613284844d54979137ce4dbb62e4f2fafab2707c9c96010c533cde57b47ad3aeaf9d67df2d74f2fbb5a969143593be6d7f9f203b7c07a7c63200b99558fdedceb23b8aca6a0797cf9cd341b2c138cce2bb96ea2c6b76c173000dd1e1dfe368351079a26fbb201cf0805e7f54b28aaff8f8ba9c474199296b34f41ef7e905be57ac43c774fc1d49252ecd273db6d33e8afa9ca2be8a0bc34bd5c3010e25262f53b417216b3a70202eb214ecd7b97a5311db5da366cd9f3bcfb965a76b25953098274898fcf46536c13e377539236a5768b44f216e21507f1f2c0aadd5010f939bd557599a59cd3bee7639fa433c9f05a8f25ddaecfad241f609e7c88a329b1fdc671882ecba518b593f1a20eadd92fc819a9508edc7d3a39afb42727551fe0111c6aa07bb2c9e16abe6efca9e93d271f95a921d8689c184079f59f78c3c625bc75851cf80377ad3d36b5eeeaf6fbfa9e7cd2f6bc1545fd30410ee51f206754014006451deb96cc100000004000000000000000000000000b6f6d86a8f9879a9c87f643768d9efc38c1da6e7000000000003b48d0f02000000000000000000000000bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c00041257424e42000000000000000000000000000000000000000000000000000000005772617070656420424e42000000000000000000000000000000000000000000000000000000000000'
        );
        expect(call.hash).toBe('0x70f0573ee82a0856db7ce842ffccb189ae9558d98c78e960d5f78ab6586857db');
        expect(call.blockNumber).toBe(blockNumber);
        expect(call.success).toBeFalsy();
        expect(call.value.toString()).toBe('0');

        expect(call.gasLimit.toString()).toBe('21000000');
        // TODO test gas price
        // expect(call.gasPrice.toString()).toBe('1297652498616');
      });

      it('can transform a contract creation tx', async () => {
        // https://blockscout.acala.network/tx/0x8154bcc173a25def96979aaf106a952d5d754a9f5d236102540453d3041425e5
        // https://acala.subscan.io/extrinsic/2051856-2
        const blockNumber = 2051856;
        const {extrinsics} = await fetchBlock(api, blockNumber);

        const [call] = (await processor.transformer({input: extrinsics[2], ds: baseDS, api})) as [AcalaEvmCall];

        expect(call.hash).toBe('0x8154bcc173a25def96979aaf106a952d5d754a9f5d236102540453d3041425e5');
        expect(call.from).toBe('0xe2e2d9e31d7e1cc1178fe0d1c5950f6c809816a3');
        expect(call.to).toBeUndefined();
        expect(call.data).toBeDefined();
        expect(call.data).not.toBe('0x');
      });
    });
  });

  // TODO test filtering calls and events
});
