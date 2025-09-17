// Copyright 2020-2025 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import '@polkadot/api-augment';
import {Interface, Result} from '@ethersproject/abi';
import {Log, TransactionResponse} from '@ethersproject/abstract-provider';
import {BigNumber} from '@ethersproject/bignumber';
import {hexDataSlice} from '@ethersproject/bytes';
import {ApiPromise} from '@polkadot/api';
import {
  EthTransactionSignature,
  EIP1559Transaction,
  // EIP7702Transaction,
  TransactionV2,
  EthTransaction,
  EvmLog,
  ExitReason,
} from '@polkadot/types/interfaces';
import {
  SubstrateCustomDatasource,
  SubstrateHandlerKind,
  SubstrateExtrinsic,
  SubstrateCustomHandler,
  SubstrateMapping,
  TypedEventRecord,
  SubstrateEvent,
  SecondLayerHandlerProcessor,
  RuntimeHandlerInputMap,
  SubstrateEventFilter,
  SubstrateCallFilter,
} from '@subql/types';
import {DsProcessor, DictionaryQueryEntry, SecondLayerHandlerProcessor_1_0_0} from '@subql/types-core';
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
import FrontierEthProvider from './frontierEthProvider';
import {Codec} from '@polkadot/types/types';

export {FrontierEthProvider};

type TopicFilter = string | null | undefined;
type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

// This is defined in newer versions of @polkadot/types but for compat versions we're using an older version
type EIP7702Transaction = Omit<EIP1559Transaction, 'action' | 'input'> & {
  data: any;
  authorizationList: any;
  destination: any;
};

// This is defined in newer versions of @polkadot/types but for compat versions we're using an older version
type TransactionV3 = TransactionV2 & {
  isEip7702: boolean;
  asEip7702: EIP7702Transaction;
};

export type FrontierEvmDatasource = SubstrateCustomDatasource<
  'substrate/FrontierEvm',
  SubstrateMapping<SubstrateCustomHandler>,
  FrontierEvmProcessorOptions
>;

export interface FrontierEvmEventFilter extends Record<string, any> {
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

export interface FrontierEvmCallFilter extends Record<string, any> {
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

export type FrontierEvmEvent<T extends Result = Result> = Optional<Log, 'blockHash' | 'transactionHash'> & {
  args?: T;
  blockTimestamp: Date;
};
export type FrontierEvmCall<T extends Result = Result> = Omit<TransactionResponse, 'wait' | 'confirmations'> & {
  args?: T;
  success: boolean;
};

@ValidatorConstraint({name: 'topicFilterValidator', async: false})
class TopicFilterValidator implements ValidatorConstraintInterface {
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

export class FrontierEvmProcessorOptions {
  /**
   * The name of the abi that is provided in the assets
   * This is the abi that will be used to decode transaction or log arguments
   * @example
   * abi: 'erc20',
   * */
  @IsOptional()
  @IsString()
  abi?: string;
  @IsOptional()
  @IsEthereumAddress()
  /**
   * The specific contract that this datasource should filter.
   * Alternatively this can be left blank and a transaction to filter can be used instead
   * @example
   * address: '0x220866B1A2219f40e72f5c628B65D54268cA3A9D',
   * */
  address?: string;
}

class FrontierEvmEventFilterImpl implements FrontierEvmEventFilter {
  @IsOptional()
  @Validate(TopicFilterValidator, {each: true})
  topics?: [TopicFilter, TopicFilter, TopicFilter, TopicFilter];
}

class FrontierEvmCallFilterImpl implements FrontierEvmCallFilter {
  @IsOptional()
  @IsEthereumAddress()
  from?: string;
  @IsOptional()
  @IsString()
  function?: string;
}

type RawEvent = {
  address: string;
  topics: string[];
  data: string;
};

type ExecutionEvent = {
  from: string;
  to?: string; // Can be undefined for contract creation
  hash: string;
  status: ExitReason;
};

function getExecutionEvent(extrinsic: SubstrateExtrinsic): ExecutionEvent {
  const executionEvent = extrinsic.events.find(
    (evt) => evt.event.section === 'ethereum' && evt.event.method === 'Executed'
  );

  if (!executionEvent) {
    throw new Error('eth execution failed');
  }

  const [from, to, hash, status] = executionEvent.event.data as unknown as [Codec, Codec, Codec, ExitReason];

  return {
    from: from.toHex(),
    to: to.toHex(),
    hash: hash.toHex(),
    status,
  };
}

async function getEtheruemBlockHash(api: ApiPromise, blockNumber: number): Promise<string | undefined> {
  return undefined;

  // This is too expensive to call for each call/event, we need to find a more efficient approach
  // In the mean time blockNumber can be used
  // See https://github.com/subquery/subql/issues/568 for more info
  const block = await api.rpc.eth.getBlockByNumber(blockNumber, false);

  return block.unwrap().blockHash.toHex();
}

const contractInterfaces: Record<string, Interface> = {};

function buildInterface(ds: FrontierEvmDatasource, assets?: Record<string, string>): Interface | undefined {
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

const EventProcessor: SecondLayerHandlerProcessor_1_0_0<
  SubstrateHandlerKind.Event,
  RuntimeHandlerInputMap,
  {
    [SubstrateHandlerKind.Event]: SubstrateEventFilter;
  },
  FrontierEvmEventFilter,
  FrontierEvmEvent,
  FrontierEvmDatasource,
  ApiPromise
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'evm', method: 'Log'}],
  baseHandlerKind: SubstrateHandlerKind.Event,
  async transformer({api, assets, ds, input: original}): Promise<[FrontierEvmEvent]> {
    const [eventData] = original.event.data;

    const {extrinsic, block} = original as SubstrateEvent<[EvmLog]>;

    const baseFilter = Array.isArray(EventProcessor.baseFilter)
      ? EventProcessor.baseFilter
      : [EventProcessor.baseFilter];
    const evmEvents =
      extrinsic?.events.filter((evt) =>
        baseFilter.find((filter) => filter.module === evt.event.section && filter.method === evt.event.method)
      ) ?? ([] as TypedEventRecord<EvmLog[]>[]);

    /*
     * Example with no extrinsic https://rata.uncoverexplorer.com/block/3450156
     * Would possibly happen with utils.batch/utils.batchAll as well
     */
    const {hash} = extrinsic ? getExecutionEvent(extrinsic) : {hash: undefined};

    const log: FrontierEvmEvent = {
      ...(eventData.toJSON() as unknown as RawEvent),
      blockNumber: original.block.block.header.number.toNumber(),
      blockHash: await getEtheruemBlockHash(api, original.block.block.header.number.toNumber()),
      blockTimestamp: block.timestamp!,
      transactionIndex: extrinsic?.idx ?? -1,
      transactionHash: hash,
      removed: false,
      logIndex: evmEvents.indexOf(original),
    };

    try {
      const iface = buildInterface(ds, assets);

      log.args = iface?.parseLog(log).args;
    } catch (e) {
      // TODO setup ts config with global defs
      (global as any).logger.warn(
        `Unable to parse log arguments, will be omitted from result: ${(e as Error).message}`
      );
    }

    return [log];
  },
  filterProcessor({ds, filter, input}): boolean {
    const [eventData] = input.event.data;
    const rawEvent = eventData as EvmLog;

    if (
      ds.processor?.options?.address &&
      !stringNormalizedEq(ds.processor.options.address, rawEvent.address.toString())
    ) {
      return false;
    }

    // Follows bloom filters https://docs.ethers.io/v5/concepts/events/#events--filters
    if (filter?.topics) {
      for (let i = 0; i < Math.min(filter.topics.length, 4); i++) {
        const topic = filter.topics[i];
        if (!topic) {
          continue;
        }

        if (!hexStringEq(eventToTopic(topic), rawEvent.topics[i].toHex())) {
          return false;
        }
      }
    }

    return true;
  },
  filterValidator(filter?: FrontierEvmEventFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(FrontierEvmEventFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Frontier event filter.\n${errorMsgs}`);
    }
  },
  dictionaryQuery(filter: FrontierEvmEventFilter, ds: FrontierEvmDatasource): DictionaryQueryEntry | undefined {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'evmLogs',
      conditions: [],
    };
    if (ds.processor?.options?.address) {
      queryEntry.conditions.push({
        field: 'address',
        value: ds.processor.options.address.toLowerCase(),
      });
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

const CallProcessor: SecondLayerHandlerProcessor_1_0_0<
  SubstrateHandlerKind.Call,
  RuntimeHandlerInputMap,
  {
    [SubstrateHandlerKind.Call]: SubstrateCallFilter;
  },
  FrontierEvmCallFilter,
  FrontierEvmCall,
  // [TransactionV3 | EthTransaction],
  FrontierEvmDatasource,
  ApiPromise
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'ethereum', method: 'transact'}],
  baseHandlerKind: SubstrateHandlerKind.Call,
  async transformer({api, assets, ds, input: original}): Promise<[FrontierEvmCall]> {
    const [tx] = original.extrinsic.method.args as [TransactionV3];

    const rawTx = tx.isEip1559
      ? tx.asEip1559
      : tx.isEip2930
        ? tx.asEip2930
        : tx.isEip7702
          ? tx.asEip7702
          : tx.isLegacy
            ? tx.asLegacy
            : (tx as unknown as EthTransaction);

    let from = '',
      hash = '',
      to,
      success;
    try {
      const executionEvent = getExecutionEvent(original);
      from = executionEvent.from;
      // There is no test for tx being of type EthTransaction
      if (!(rawTx as EIP1559Transaction).action || !(rawTx as EIP1559Transaction).action.isCreate) {
        to = executionEvent.to;
      }
      hash = executionEvent.hash;
      success = executionEvent.status.isSucceed;
    } catch (e) {
      logger.warn(
        `Unable to get executionEvent for call. block='${original.block.block.header.number.toNumber()}', index='${
          original.idx
        }'`
      );
      success = false;
    }

    let call: FrontierEvmCall;

    // Special handling for signatures, the data doesn't align with the types for historical data
    function extractSignature(tx: typeof rawTx): {r: string; s: string; v?: number} {
      function hasSignature(tx: any): tx is {signature: EthTransactionSignature} {
        return !!tx.signature;
      }
      if (hasSignature(tx)) {
        return {
          r: tx.signature.r.toHex(),
          s: tx.signature.s.toHex(),
          v: (tx.signature as any).v?.toNumber(), // Bad types
        };
      }
      return {
        r: (tx as EthTransaction).r.toHex(),
        s: (tx as EthTransaction).s.toHex(),
        v: (tx as EthTransaction).v?.toNumber(),
      };
    }

    const baseCall /* : Partial<FrontierEvmCall> */ = {
      from,
      to, // when contract creation
      nonce: rawTx.nonce.toNumber(),
      value: BigNumber.from(rawTx.value.toBigInt()),

      // Transaction response properties
      hash,
      blockNumber: original.block.block.header.number.toNumber(),
      blockHash: await getEtheruemBlockHash(api, original.block.block.header.number.toNumber()),
      timestamp: Math.round(original.block.timestamp!.getTime() / 1000),
      success,

      ...extractSignature(rawTx),
    };

    if (tx.isEip1559) {
      const eip1559tx = tx.asEip1559;

      call = {
        ...baseCall,
        data: eip1559tx.input.toHex(),
        chainId: eip1559tx.chainId.toNumber(),
        gasLimit: BigNumber.from(eip1559tx.gasLimit.toBigInt()),
        maxFeePerGas: BigNumber.from(eip1559tx.maxFeePerGas.toBigInt()),
        maxPriorityFeePerGas: BigNumber.from(eip1559tx.maxPriorityFeePerGas.toBigInt()),

        // s: eip1559tx.signature.s.toHex(),
        // r: eip1559tx.signature.r.toHex(),
        type: 2,
      };
    } else if (tx.isEip2930) {
      const eip2930tx = tx.asEip2930;

      call = {
        ...baseCall,
        data: eip2930tx.input.toHex(),
        chainId: eip2930tx.chainId.toNumber(),
        gasPrice: BigNumber.from(eip2930tx.gasPrice.toBigInt()),
        gasLimit: BigNumber.from(eip2930tx.gasLimit.toBigInt()),
        // s: ((eip2930tx as any).s ?? eip2930tx.signature.s).toHex(),
        // r: ((eip2930tx as any).r ?? eip2930tx.signature.r).toHex(),
        type: 1,
      };
    } else if (tx.isEip7702) {
      const eip7702tx = tx.asEip7702;

      call = {
        ...baseCall,
        data: '',
        chainId: eip7702tx.chainId.toNumber(),
        gasLimit: BigNumber.from(eip7702tx.gasLimit.toBigInt()),
        maxFeePerGas: BigNumber.from(eip7702tx.maxFeePerGas.toBigInt()),
        maxPriorityFeePerGas: BigNumber.from(eip7702tx.maxPriorityFeePerGas.toBigInt()),
        // s: eip7702tx.signature.s.toHex(),
        // r: eip7702tx.signature.r.toHex(),
        type: 3,
      };
    } /*if ((tx.isLegacy))*/ else {
      const legacyTx = tx.asLegacy ?? tx;

      call = {
        ...baseCall,
        data: legacyTx.input.toHex(),
        gasLimit: BigNumber.from(legacyTx.gasLimit.toBigInt()),
        gasPrice: BigNumber.from(legacyTx.gasPrice.toBigInt()),
        chainId: -1, // Unkonwn

        // r: legacyTx.signature.r.toHex(),
        // s: legacyTx.signature.s.toHex(),
        // v: legacyTx.signature.v.toNumber(),
        type: 0,
      };
    } /* else {
      const ethTx = tx as EthTransaction;
      console.log(`XXXXXX ${(tx as any).asLegacy}`)

      call = {
        ...baseCall,

        maxFeePerGas: BigNumber.from(ethTx.maxFeePerGas.unwrap().toBigInt()),
        maxPriorityFeePerGas: BigNumber.from(ethTx.maxPriorityFeePerGas.unwrap().toBigInt()),

        gasLimit: BigNumber.from(0),
        gasPrice: BigNumber.from(ethTx.gasPrice.unwrap().toBigInt()),
        chainId: ethTx.chainId.unwrap().toNumber(),

        r: ethTx.r.toHex(),
        s: ethTx.s.toHex(),
        v: ethTx.v.toNumber(),
        type: 0,
      };
    }*/

    try {
      const iface = buildInterface(ds, assets);

      call.args = iface?.decodeFunctionData(iface.getFunction(hexDataSlice(call.data, 0, 4)), call.data);
    } catch (e) {
      // TODO setup ts config with global defs
      (global as any).logger.warn(`Unable to parse call arguments, will be omitted from result`);
    }

    return [call];
  },
  filterProcessor({ds, filter, input}): boolean {
    try {
      const {from, to} = getExecutionEvent(input);

      if (filter?.from && !stringNormalizedEq(filter.from, from)) {
        return false;
      }

      const [tx] = input.extrinsic.method.args as [TransactionV3];

      const rawTx = tx.isEip1559
        ? tx.asEip1559
        : tx.isEip2930
          ? tx.asEip2930
          : tx.isEip7702
            ? tx.asEip7702
            : tx.isLegacy
              ? tx.asLegacy
              : (tx as unknown as EthTransaction);
      // if `to` is null then we handle contract creation
      if (
        (ds.processor?.options?.address && !stringNormalizedEq(ds.processor.options.address, to)) ||
        (ds.processor?.options?.address === null && !(rawTx as EIP1559Transaction).action?.isCreate)
      ) {
        return false;
      }

      if (!tx.isEip7702) {
        const tx = rawTx as Exclude<typeof rawTx, EIP7702Transaction>;
        if (filter?.function && tx.input.toHex().indexOf(functionToSighash(filter.function)) !== 0) {
          return false;
        }
      }

      return true;
    } catch (e) {
      (global as any).logger.warn('Unable to properly filter input');
      return false;
    }
  },
  filterValidator(filter?: FrontierEvmCallFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(FrontierEvmCallFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Frontier Evm call filter.\n${errorMsgs}`);
    }
  },
  dictionaryQuery(filter: FrontierEvmCallFilter, ds: FrontierEvmDatasource): DictionaryQueryEntry | undefined {
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

export const FrontierEvmDatasourcePlugin = <
  DsProcessor<
    FrontierEvmDatasource,
    {
      'substrate/FrontierEvmEvent': typeof EventProcessor;
      'substrate/FrontierEvmCall': typeof CallProcessor;
    }
  >
>{
  kind: 'substrate/FrontierEvm',
  validate(ds, assets: Record<string, string>): void {
    if (ds.processor.options) {
      const opts = plainToClass(FrontierEvmProcessorOptions, ds.processor.options);
      const errors = validateSync(opts, {whitelist: true, forbidNonWhitelisted: true});
      if (errors?.length) {
        const errorMsgs = errors.map((e) => e.toString()).join('\n');
        throw new Error(`Invalid Frontier Evm call filter.\n${errorMsgs}`);
      }
    }

    buildInterface(ds, assets); // Will throw if unable to construct

    return;
  },
  dsFilterProcessor(ds): boolean {
    return ds.kind === this.kind;
  },
  handlerProcessors: {
    'substrate/FrontierEvmEvent': EventProcessor,
    'substrate/FrontierEvmCall': CallProcessor,
  },
};

export default FrontierEvmDatasourcePlugin;
