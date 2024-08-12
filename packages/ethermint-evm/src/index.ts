import {
  // SecondLayerHandlerProcessor_1_0_0,
  CosmosCustomDatasource,
  CosmosCustomHandler,
  CosmosHandlerKind,
  CosmosMapping,
  CosmosDatasourceProcessor,
  CosmosEvent,
  SecondLayerHandlerProcessor,
} from '@subql/types-cosmos';
import {DictionaryQueryEntry} from '@subql/types-core';
import {
  IsOptional,
  validateSync,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
  IsEthereumAddress,
  IsString,
} from 'class-validator';
import {hexDataSlice} from '@ethersproject/bytes';
import {Log, TransactionResponse} from '@ethersproject/abstract-provider';
import {Interface, Result} from '@ethersproject/abi';
import {HashZero} from '@ethersproject/constants';
import {BigNumber} from '@ethersproject/bignumber';
import {eventToTopic, functionToSighash, hexStringEq, stringNormalizedEq} from './utils';
import {plainToClass} from 'class-transformer';
import {parseRawLog} from '@cosmjs/stargate/build/logs';
export interface Attribute {
  readonly key: string;
  readonly value: string;
}

type TopicFilter = string | null | undefined;
type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export interface EthermintEvmEventFilter extends Record<string, any> {
  topics?: [TopicFilter, TopicFilter?, TopicFilter?, TopicFilter?];
}

export type EthermintEvmDatasource = CosmosCustomDatasource<
  'cosmos/EthermintEvm',
  CosmosMapping<CosmosCustomHandler>,
  EthermintEvmProcessorOptions
>;

export interface EthermintEvmCallFilter extends Record<string, any> {
  from?: string;
  method?: string;
}

class EthermintEvmCallFilterImpl implements EthermintEvmCallFilter {
  @IsOptional()
  @IsEthereumAddress()
  from?: string;
  @IsOptional()
  @IsString()
  method?: string;
}

export type EthermintEvmCall<T extends Result = Result> = Omit<TransactionResponse, 'wait' | 'confirmations'> & {
  args?: T;
  success: boolean;
};

export type EthermintEvmEvent<T extends Result = Result> = Optional<Log, 'blockHash' | 'transactionHash'> & {
  args?: T;
  blockTimestamp: Date;
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

class EthermintEvmEventFilterImpl implements EthermintEvmEventFilter {
  @IsOptional()
  @Validate(TopicFilterValidator, {each: true})
  topics?: [TopicFilter, TopicFilter, TopicFilter, TopicFilter];
}

export class EthermintEvmProcessorOptions {
  @IsOptional()
  @IsString()
  abi?: string;
  @IsOptional()
  @IsEthereumAddress()
  address?: string;
}

const contractInterfaces: Record<string, Interface> = {};

function buildInterface(ds: EthermintEvmDatasource, assets?: Record<string, string>): Interface | undefined {
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

function retrieveLogs(attributes: Attribute[]) {
  return attributes.reduce((acc, attr) => {
    if (attr.key === 'txLog') {
      acc.push(JSON.parse(attr.value));
    }
    return acc;
  }, [] as any[]);
}

function logMatchesTopics(log: any, topics: EthermintEvmEventFilter['topics']): boolean {
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

function findLogs(address: string | undefined, filter: EthermintEvmEventFilter | undefined, input: CosmosEvent): any[] {
  const logs = retrieveLogs(input.event.attributes as Attribute[]);
  return logs
    .filter((log) => (address ? hexStringEq(log.address, address) : true)) // Filter events for matching contract address
    .filter((log) => logMatchesTopics(log, filter?.topics)); // Filter by topics
}

function isSuccess(rawLog: string, index: number): boolean {
  try {
    const log = parseRawLog(rawLog).find((l) => l.msg_index === index);
    const txLog = log?.events.find((evt) => evt.type === 'ethereumTx');
    const failLog = txLog?.attributes.find((attr) => attr.key === 'ethereumTxFailed');
    return failLog === undefined;
  } catch (e) {
    return false;
  }
}

const EventProcessor: SecondLayerHandlerProcessor<
  CosmosHandlerKind.Event,
  EthermintEvmEventFilter,
  EthermintEvmEvent,
  EthermintEvmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{type: 'tx_log'}],
  baseHandlerKind: CosmosHandlerKind.Event,
  async transformer({assets, ds, filter, input: original}): Promise<EthermintEvmEvent[]> {
    const logs = findLogs(ds.processor?.options?.address, filter, original);
    return logs.map((l) => {
      const log: EthermintEvmEvent = {
        ...l,
        blockNumber: original.block.block.header.height,
        blockHash: original.block.block.id,
        blockTimestamp: original.block.block.header.time,
      };

      log.data = log.data ? '0x' + Buffer.from(log.data, 'base64').toString('hex') : HashZero;

      try {
        const iface = buildInterface(ds, assets);

        log.args = iface?.parseLog(log).args;
      } catch (e) {
        // TODO setup ts config with 5***** defs
        (global as any).logger?.warn(
          `Unable to parse log arguments, will be omitted from result: ${(e as Error).message}`
        );
      }

      return log as EthermintEvmEvent;
    });
  },

  filterProcessor({ds, filter, input}): boolean {
    if (!findLogs(ds.processor?.options?.address, filter, input).length) return false;

    return true;
  },

  filterValidator(filter?: EthermintEvmEventFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(EthermintEvmEventFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Ethermint event filter.\n${errorMsgs}`);
    }
  },

  dictionaryQuery(filter: EthermintEvmEventFilter, ds: EthermintEvmDatasource): DictionaryQueryEntry | undefined {
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

const MessageProcessor: SecondLayerHandlerProcessor<
  CosmosHandlerKind.Message,
  EthermintEvmCallFilter,
  EthermintEvmCall,
  EthermintEvmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{type: '/ethermint.evm.v1.MsgEthereumTx'}],
  baseHandlerKind: CosmosHandlerKind.Message,
  async transformer({assets, ds, input: original}): Promise<[EthermintEvmCall]> {
    let call: EthermintEvmCall;

    const baseCall = {
      from: original.msg.decodedMsg.from,
      to: original.msg.decodedMsg.data.to,
      nonce: original.msg.decodedMsg.data.nonce,
      data: '0x' + Buffer.from(original.msg.decodedMsg.data.data ?? '').toString('hex'),
      hash: original.msg.decodedMsg.hash,
      value: original.msg.decodedMsg.data.value.toString(),
      blockNumber: original.block.block.header.height,
      blockHash: original.block.block.id,
      timestamp: original.block.block.header.time.getDate(),
      gasLimit: original.msg.decodedMsg.data.gas,
      success: isSuccess(original.tx.tx.log ?? '', original.idx),
    };

    if (original.msg.decodedMsg.data.typeUrl === '/ethermint.evm.v1.DynamicFeeTx') {
      call = {
        ...baseCall,
        chainId: original.msg.decodedMsg.data.chainId,
        maxFeePerGas: BigNumber.from(original.msg.decodedMsg.data.gasFeeCap),
        maxPriorityFeePerGas: BigNumber.from(original.msg.decodedMsg.data.gasTipCap),

        s: original.msg.decodedMsg.data.s,
        r: original.msg.decodedMsg.data.r,
        type: 2,
      };
    } else if (original.msg.decodedMsg.data.typeUrl === '/ethermint.evm.v1.AccessListTx') {
      call = {
        ...baseCall,
        chainId: original.msg.decodedMsg.data.chainId,
        gasPrice: BigNumber.from(original.msg.decodedMsg.data.gasPrice),
        gasLimit: BigNumber.from(original.msg.decodedMsg.data.gasLimit),

        s: original.msg.decodedMsg.data.s,
        r: original.msg.decodedMsg.data.r,
        type: 1,
      };
    } else {
      call = {
        ...baseCall,
        chainId: -1,
        gasPrice: BigNumber.from(original.msg.decodedMsg.data.gasPrice),
        r: original.msg.decodedMsg.data.r,
        s: original.msg.decodedMsg.data.s,
        v: original.msg.decodedMsg.data.v,
        type: 0,
      };
    }

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
      const decodedTxData = (global as any).registry.decode(input.msg.decodedMsg.data);
      input.msg.decodedMsg.data = {
        typeUrl: input.msg.decodedMsg.data.typeUrl,
        ...decodedTxData,
      };

      const from = input.msg.decodedMsg.from;
      if (filter?.from && !stringNormalizedEq(filter.from, from)) {
        return false;
      }

      const to = input.msg.decodedMsg.data.to;
      if (ds.processor?.options?.address && !stringNormalizedEq(ds.processor.options.address, to)) {
        return false;
      }

      if (
        filter?.method &&
        ('0x' + Buffer.from(input.msg.decodedMsg.data.data).toString('hex')).indexOf(
          functionToSighash(filter.method)
        ) === -1
      ) {
        return false;
      }

      return true;
    } catch (e) {
      (global as any).logger.warn(e, 'Unable to properly filter input');
      return false;
    }
  },

  filterValidator(filter?: EthermintEvmCallFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(EthermintEvmCallFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Ethermint Evm Message filter.\n${errorMsgs}`);
    }
  },

  dictionaryQuery(filter: EthermintEvmCallFilter, ds: EthermintEvmDatasource): DictionaryQueryEntry | undefined {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'evmTransactions',
      conditions: [],
    };
    if (ds.processor?.options?.address) {
      queryEntry.conditions.push({field: 'to', value: ds.processor.options.address});
    }
    if (filter?.from) {
      queryEntry.conditions.push({field: 'from', value: filter.from});
    }

    if (filter?.method) {
      queryEntry.conditions.push({field: 'func', value: functionToSighash(filter.method)});
    }
    return queryEntry;
  },
};

export const EthermintEvmDatasourcePlugin = <
  CosmosDatasourceProcessor<
    'cosmos/EthermintEvm',
    any,
    EthermintEvmDatasource,
    {
      'cosmos/EthermintEvmEvent': typeof EventProcessor;
      'cosmos/EthermintEvmCall': typeof MessageProcessor;
    }
  >
>{
  kind: 'cosmos/EthermintEvm',
  validate(ds: EthermintEvmDatasource, assets: Record<string, string>): void {
    if (ds?.processor?.options) {
      const opts = plainToClass(EthermintEvmProcessorOptions, ds.processor.options);
      const errors = validateSync(opts, {whitelist: true, forbidNonWhitelisted: true});
      if (errors?.length) {
        const errorMsgs = errors.map((e) => e.toString()).join('\n');
        throw new Error(`Invalid Ethermint Evm call filter.\n${errorMsgs}`);
      }
    }

    buildInterface(ds, assets); // Will throw if unable to construct

    return;
  },
  dsFilterProcessor(ds: EthermintEvmDatasource): boolean {
    return ds.kind === this.kind;
  },
  handlerProcessors: {
    'cosmos/EthermintEvmEvent': EventProcessor,
    'cosmos/EthermintEvmCall': MessageProcessor,
  },
};

export default EthermintEvmDatasourcePlugin;
