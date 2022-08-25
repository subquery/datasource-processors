// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {Result} from '@ethersproject/abi';
import {TransactionV2, EthTransaction, EvmLog} from '@polkadot/types/interfaces';
import {
  SecondLayerHandlerProcessor,
  SubstrateCustomDatasource,
  SubstrateCustomHandler,
  SubstrateDatasourceProcessor,
  SubstrateHandlerKind,
  SubstrateMapping,
  SubstrateNetworkFilter,
} from '@subql/types';
import FrontierEvmDatasourcePlugin, {
  FrontierEvmCall,
  FrontierEvmEvent,
  FrontierEvmEventFilter,
  FrontierEvmCallFilter,
  FrontierEvmProcessorOptions,
  FrontierEvmDatasource,
} from '@subql/frontier-evm-processor';

export type MoonbeamCall<T extends Result = Result> = FrontierEvmCall<T>;
export type MoonbeamEvent<T extends Result = Result> = FrontierEvmEvent<T>;
export type MoonbeamEventFilter = FrontierEvmEventFilter;
export type MoonbeamCallFilter = FrontierEvmCallFilter;

export type MoonbeamDatasource = SubstrateCustomDatasource<
  'substrate/Moonbeam',
  SubstrateNetworkFilter,
  SubstrateMapping<SubstrateCustomHandler>,
  FrontierEvmProcessorOptions
>;

type MoonbeamEventSecondLayerHandlerProcessor = SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Event,
  MoonbeamEventFilter,
  MoonbeamEvent,
  [EvmLog],
  MoonbeamDatasource
>;

type MoonbeamCallSecondLayerHandlerProcessor = SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Call,
  MoonbeamCallFilter,
  MoonbeamCall,
  [TransactionV2 | EthTransaction],
  MoonbeamDatasource
>;

export const MoonbeamDatasourcePlugin: SubstrateDatasourceProcessor<
  'substrate/Moonbeam',
  SubstrateNetworkFilter,
  MoonbeamDatasource
> = {
  kind: 'substrate/Moonbeam',
  validate: (ds, assets) => FrontierEvmDatasourcePlugin.validate(ds as unknown as FrontierEvmDatasource, assets),
  dsFilterProcessor(ds: MoonbeamDatasource): boolean {
    return ds.kind === this.kind;
  },
  handlerProcessors: {
    'substrate/MoonbeamEvent': FrontierEvmDatasourcePlugin.handlerProcessors[
      'substrate/FrontierEvmEvent'
    ] as unknown as MoonbeamEventSecondLayerHandlerProcessor,
    'substrate/MoonbeamCall': FrontierEvmDatasourcePlugin.handlerProcessors[
      'substrate/FrontierEvmCall'
    ] as unknown as MoonbeamCallSecondLayerHandlerProcessor,
  },
};

export default MoonbeamDatasourcePlugin;
