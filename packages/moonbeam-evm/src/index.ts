// Copyright 2020-2025 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {Result} from '@ethersproject/abi';
import {
  SecondLayerHandlerProcessor,
  SubstrateCustomDatasource,
  SubstrateCustomHandler,
  SubstrateDatasourceProcessor,
  SubstrateHandlerKind,
  SubstrateMapping,
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
  SubstrateMapping<SubstrateCustomHandler>,
  FrontierEvmProcessorOptions
>;

type MoonbeamEventSecondLayerHandlerProcessor = SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Event,
  MoonbeamEventFilter,
  MoonbeamEvent,
  // [EvmLog],
  MoonbeamDatasource
>;

type MoonbeamCallSecondLayerHandlerProcessor = SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Call,
  MoonbeamCallFilter,
  MoonbeamCall,
  // [TransactionV2 | EthTransaction],
  MoonbeamDatasource
>;

export const MoonbeamDatasourcePlugin: SubstrateDatasourceProcessor<
  'substrate/Moonbeam',
  MoonbeamEventFilter | MoonbeamCallFilter,
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
