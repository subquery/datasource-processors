// Copyright 2020-2023 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {
  getPartialTransactionReceipt,
  PartialLog,
  // } from '@acala-network/eth-providers/lib/utils/transactionReceiptHelper';
} from './acalaUtils';
import {Interface, Result} from '@ethersproject/abi';
import type {Log, TransactionResponse} from '@ethersproject/abstract-provider';
import {BigNumber} from '@ethersproject/bignumber';
import {hexDataSlice} from '@ethersproject/bytes';
import {AnyTuple} from '@polkadot/types/types';
import {
  SubstrateDatasourceProcessor,
  SubstrateCustomDatasource,
  SubstrateHandlerKind,
  SubstrateEvent,
  SubstrateExtrinsic,
  SubstrateCustomHandler,
  SubstrateMapping,
  SecondLayerHandlerProcessor,
} from '@subql/types';
import {DictionaryQueryEntry} from '@subql/types-core';
import {plainToClass} from 'class-transformer';
import {
  IsOptional,
  validateSync,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
  IsEthereumAddress,
  IsString,
} from 'class-validator';
import {eventToTopic, functionToSighash, hexStringEq, stringNormalizedEq} from './utils';

// https://github.com/AcalaNetwork/bodhi.js/blob/master/evm-subql/src/mappings/mappingHandlers.ts#L10
const DUMMY_TX_HASH = '0x6666666666666666666666666666666666666666666666666666666666666666';
const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000';

type TopicFilter = string | null | undefined;

export type AcalaEvmDatasource = SubstrateCustomDatasource<
  'substrate/AcalaEvm',
  SubstrateMapping<SubstrateCustomHandler>,
  AcalaEvmProcessorOptions
>;

export interface AcalaEvmEventFilter extends Record<string, any> {
  /**
   * You can filter by the topics in a log.
   * These can be an address, event signature, null, '!null' or undefined
   * @example
   * topics: ['Transfer(address, address, uint256)'],
   * @example
   * topics: ['Transfer(address, address, uint256)', undefined, '0x220866B1A2219f40e72f5c628B65D54268cA3A9D']
   */
  topics?: [TopicFilter, TopicFilter?, TopicFilter?, TopicFilter?];
}

export interface AcalaEvmCallFilter extends Record<string, any> {
  /**
   * The address of sender of the transaction
   * @example
   * from: '0x220866B1A2219f40e72f5c628B65D54268cA3A9D',
   * */
  from?: string;
  /**
   * The function sighash or function signature of the call. This is the first 32bytes of the data field
   * @example
   * function: 'setminimumStakingAmount(uint256 amount)',
   * */
  function?: string;
}

// TODO add valid_until, access_list
export type AcalaEvmEvent<T extends Result = Result> = Log & {args?: T; blockTimestamp: Date; from: string};
export type AcalaEvmCall<T extends Result = Result> = Omit<
  TransactionResponse,
  'wait' | 'confirmations' | 'r' | 's' | 'v' | 'chainId'
> & {
  args?: T;
  success: boolean;
};

@ValidatorConstraint({name: 'topifFilterValidator', async: false})
export class TopicFilterValidator implements ValidatorConstraintInterface {
  validate(value: TopicFilter): boolean {
    try {
      return !value || (typeof value === 'string' ? !!eventToTopic(value) : false);
    } catch (e) {
      return false;
    }
  }

  defaultMessage(): string {
    return 'Value must be either null, undefined, hex string or hex string[]';
  }
}

class AcalaEvmProcessorOptions {
  /**
   * The name of the abi that is provided in the assets
   * This is the abi that will be used to decode transaction or log arguments
   * @example
   * abi: 'erc20',
   * */
  @IsOptional()
  @IsString()
  abi?: string;
  /**
   * The specific contract that this datasource should filter.
   * @example
   * address: '0x220866B1A2219f40e72f5c628B65D54268cA3A9D',
   * */
  @IsOptional()
  @IsEthereumAddress()
  address?: string;
}

class AcalaEventFilterImpl implements AcalaEvmEventFilter {
  @IsOptional()
  @Validate(TopicFilterValidator, {each: true})
  topics?: [TopicFilter, TopicFilter, TopicFilter, TopicFilter];
}

class AcalaCallFilterImpl implements AcalaEvmCallFilter {
  @IsOptional()
  @IsEthereumAddress()
  from?: string;
  @IsOptional()
  @IsString()
  function?: string;
}

type ExecutionEvent = {
  from: string;
  to?: string; // Undefined for contract creation
  logs?: unknown; // TODO Vec<EtheruemLog>
};

function getExecutionEvent(extrinsic: SubstrateExtrinsic): ExecutionEvent {
  const executionEvent = extrinsic.events.find(
    (evt) =>
      evt.event.section === 'evm' &&
      ['Executed', 'ExecutedFailed', 'Created', 'CreatedFailed'].includes(evt.event.method)
  );

  if (!executionEvent) {
    throw new Error('eth execution failed');
  }

  const [from, to, logs] = executionEvent.event.data;

  return {
    from: from.toHex(),
    to: executionEvent.event.method === 'Created' ? undefined : to.toHex(),
    logs,
  };
}

const contractInterfaces: Record<string, Interface> = {};

function buildInterface(ds: AcalaEvmDatasource, assets?: Record<string, string>): Interface | undefined {
  const abi = ds.processor?.options?.abi;
  if (!abi || !assets) {
    return;
  }

  if (!ds.assets?.get(abi)) {
    throw new Error(`ABI named "${abi}" not referenced in assets`);
  }

  // This assumes that all datasources have a different abi name or they are the same abi
  if (!contractInterfaces[abi]) {
    // Constructing the interface validates the ABI
    try {
      let abiObj = JSON.parse(assets[abi]);

      /*
       * Allows parsing JSON artifacts as well as ABIs
       * https://trufflesuite.github.io/artifact-updates/background.html#what-are-artifacts
       */
      if (!Array.isArray(abiObj) && abiObj.abi) {
        abiObj = abiObj.abi;
      }

      contractInterfaces[abi] = new Interface(abiObj);
    } catch (e) {
      (global as any).logger.error(e, `Unable to parse ABI`);
      throw new Error('ABI is invalid');
    }
  }

  return contractInterfaces[abi];
}

function logMatchesTopics(log: PartialLog, topics: AcalaEvmEventFilter['topics']): boolean {
  // Follows bloom filters https://docs.ethers.io/v5/concepts/events/#events--filters

  if (!topics) return true;

  for (let i = 0; i < Math.min(topics.length, 4); i++) {
    const topic = topics[i];
    if (!topic) {
      continue;
    }
    if (!hexStringEq(eventToTopic(topic), log.topics[i])) {
      return false;
    }
  }

  return true;
}

function findLogs(
  address: string | undefined,
  filter: AcalaEvmEventFilter | undefined,
  input: SubstrateEvent
): PartialLog[] {
  const receipt = getPartialTransactionReceipt(input as any);

  return receipt.logs
    .filter((log) => (address ? hexStringEq(log.address, address) : true)) // Filter events for matching contract address
    .filter((log) => logMatchesTopics(log, filter?.topics)); // Filter by topics
}

const EventProcessor: SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Event,
  AcalaEvmEventFilter,
  AcalaEvmEvent,
  // AnyTuple, // TODO improve this type
  AcalaEvmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'evm', method: 'Executed'}], // TODO executed failed
  baseHandlerKind: SubstrateHandlerKind.Event,
  // eslint-disable-next-line @typescript-eslint/require-await
  async transformer({assets, ds, filter, input: original}): Promise<AcalaEvmEvent[]> {
    const input = original as SubstrateEvent;

    // Acala EVM has all the logs in one substrate event, we need to process all the matching events.
    const partialLogs = findLogs(ds.processor?.options?.address, filter, input);
    const from = input.extrinsic ? getExecutionEvent(input.extrinsic).from : EMPTY_ADDRESS;

    return partialLogs.map((partialLog) => {
      const log: AcalaEvmEvent = {
        ...partialLog,
        blockNumber: input.block.block.header.number.toNumber(),
        blockHash: input.block.hash.toHex(),
        blockTimestamp: input.block.timestamp!,
        transactionIndex: input.extrinsic?.idx ?? -1,
        transactionHash: input.extrinsic?.extrinsic.hash.toHex() ?? DUMMY_TX_HASH,
        from,
      };

      try {
        const iface = buildInterface(ds, assets);

        log.args = iface?.parseLog(log).args;
      } catch (e) {
        // TODO setup ts config with global defs
        (global as any).logger?.warn(
          `Unable to parse log arguments, will be omitted from result: ${(e as Error).message}`
        );
      }

      return log;
    });
  },
  filterProcessor({ds, filter, input}): boolean {
    if (!findLogs(ds.processor?.options?.address, filter, input as SubstrateEvent).length) return false;

    return true;
  },
  filterValidator(filter?: AcalaEvmEventFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(AcalaEventFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Acala event filter.\n${errorMsgs}`);
    }
  },
  dictionaryQuery(filter: AcalaEvmEventFilter, ds: AcalaEvmDatasource): DictionaryQueryEntry | undefined {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'evmLogs',
      conditions: [],
    };
    if (ds.processor?.options?.address) {
      queryEntry.conditions.push({field: 'address', value: ds.processor.options.address.toLowerCase()});
    } else {
      return;
    }

    // Follows bloom filters https://docs.ethers.io/v5/concepts/events/#events--filters
    if (filter?.topics) {
      for (let i = 0; i < Math.min(filter.topics.length, 4); i++) {
        const topic = filter.topics[i];
        if (!topic) {
          continue;
        }
        const field = `topics${i}`;
        queryEntry.conditions.push({field, value: eventToTopic(topic)});
      }
    }
    return queryEntry;
  },
};

const CallProcessor: SecondLayerHandlerProcessor<
  SubstrateHandlerKind.Call,
  AcalaEvmCallFilter,
  AcalaEvmCall,
  // AnyTuple, // TODO improve this type
  AcalaEvmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'evm', method: 'ethCall'}],
  baseHandlerKind: SubstrateHandlerKind.Call,
  // eslint-disable-next-line @typescript-eslint/require-await
  async transformer({assets, ds, input: original}): Promise<[AcalaEvmCall]> {
    const [tx, input, value, gasLimit] = original.extrinsic.method.args;

    const {from, to} = getExecutionEvent(original);

    const success = !!original.events.find((evt) => evt.event.section === 'evm' && evt.event.method === 'Executed');

    const call: AcalaEvmCall = {
      // Transaction properties
      from,
      to, // when contract creation
      nonce: original.extrinsic.nonce.toNumber(),
      gasLimit: BigNumber.from(gasLimit.toHex()),
      gasPrice: BigNumber.from(0), // TODO
      data: input.toHex(),
      value: BigNumber.from(value.toHex()),

      // Transaction response properties
      hash: original.extrinsic.hash.toHex(), // Substrate extrinsic hash
      blockNumber: original.block.block.header.number.toNumber(),
      blockHash: original.block.block.hash.toHex(), // Substrate block hash
      timestamp: Math.round(original.block.timestamp!.getTime() / 1000),
      success,
    };

    try {
      const iface = buildInterface(ds, assets);

      call.args = iface?.decodeFunctionData(iface.getFunction(hexDataSlice(call.data, 0, 4)), call.data);
    } catch (e) {
      // TODO setup ts config with global defs
      (global as any).logger?.warn(`Unable to parse call arguments, will be omitted from result`);
    }

    return [call];
  },
  filterProcessor({ds, filter, input}): boolean {
    try {
      const {from, to} = getExecutionEvent(input);

      if (filter?.from && !stringNormalizedEq(filter.from, from)) {
        return false;
      }

      const [_, txInput] = input.extrinsic.method.args as [any, any];

      if (ds.processor?.options?.address && !stringNormalizedEq(ds.processor.options.address, to)) {
        return false;
      }

      if (filter?.function && txInput.toHex().indexOf(functionToSighash(filter.function)) !== 0) {
        return false;
      }

      return true;
    } catch (e) {
      (global as any).logger?.warn('Unable to properly filter input');
      return false;
    }
  },
  filterValidator(filter?: AcalaEvmCallFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(AcalaCallFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Acala call filter.\n${errorMsgs}`);
    }
  },
  dictionaryQuery(filter: AcalaEvmCallFilter, ds: AcalaEvmDatasource): DictionaryQueryEntry | undefined {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'evmTransactions',
      conditions: [],
    };
    if (ds.processor?.options?.address) {
      queryEntry.conditions.push({field: 'to', value: ds.processor.options.address.toLowerCase()});
    }
    if (filter?.from) {
      queryEntry.conditions.push({field: 'from', value: filter.from.toLowerCase()});
    }

    if (filter?.function) {
      queryEntry.conditions.push({field: 'func', value: functionToSighash(filter.function)});
    }
    return queryEntry;
  },
};

export const AcalaDatasourcePlugin = <
  SubstrateDatasourceProcessor<
    'substrate/AcalaEvm',
    AcalaEvmEventFilter | AcalaEvmCallFilter,
    AcalaEvmDatasource,
    {
      'substrate/AcalaEvmEvent': typeof EventProcessor;
      'substrate/AcalaEvmCall': typeof CallProcessor;
    }
  >
>{
  kind: 'substrate/AcalaEvm',
  validate(ds: AcalaEvmDatasource, assets: Record<string, string>): void {
    if (ds.processor.options) {
      const opts = plainToClass(AcalaEvmProcessorOptions, ds.processor.options);
      const errors = validateSync(opts, {whitelist: true, forbidNonWhitelisted: true});
      if (errors?.length) {
        const errorMsgs = errors.map((e) => e.toString()).join('\n');
        throw new Error(`Invalid Acala call filter.\n${errorMsgs}`);
      }
    }

    buildInterface(ds, assets); // Will throw if unable to construct

    return;
  },
  dsFilterProcessor(ds: AcalaEvmDatasource): boolean {
    return ds.kind === this.kind;
  },
  handlerProcessors: {
    'substrate/AcalaEvmEvent': EventProcessor,
    'substrate/AcalaEvmCall': CallProcessor,
  },
};

export default AcalaDatasourcePlugin;
