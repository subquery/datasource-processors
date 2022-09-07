// Copyright 2020-2021 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {Bytes, Option, Compact, u128} from '@polkadot/types';
import {BalanceOf, Address, Weight} from '@polkadot/types/interfaces/runtime';
import {hexToU8a, u8aToU8a} from '@polkadot/util';

import {
  SubstrateDatasourceProcessor,
  SubstrateCustomDatasource,
  SubstrateHandlerKind,
  SubstrateNetworkFilter,
  SubstrateCustomHandler,
  SubstrateMapping,
  DictionaryQueryEntry,
  SecondLayerHandlerProcessor_1_0_0,
} from '@subql/types';
import {plainToClass} from 'class-transformer';
import {IsOptional, validateSync, IsString} from 'class-validator';
import {stringNormalizedEq, isCustomDs} from './utils';
import {Abi} from '@polkadot/api-contract';
import {AbiMessage, DecodedEvent, DecodedMessage} from '@polkadot/api-contract/types';
import {AccountId} from '@polkadot/types/interfaces';
import fs from 'fs';
import {compactStripLength, u8aToHex} from '@polkadot/util';
const EMPTY_ADDRESS = '0x0000000000000000000000000000000000000000';

type IdentifierFilter = string | null | undefined;

interface SpecDef {
  messages: {
    label: string;
    name: string[] | string;
    selector: string;
  }[];

  events: {
    args: any[];
    docs: string[];
    label: string;
  }[];
}

interface JSONAbi {
  source: {
    compiler: string;
    hash: string;
    language: string;
    wasm: string;
  };
  spec: SpecDef;
  V1: {
    spec: SpecDef;
  };
  V2: {
    spec: SpecDef;
  };
  V3: {
    spec: SpecDef;
  };
  V4: {
    spec: SpecDef;
  };
}

export interface Result extends ReadonlyArray<any> {
  readonly [key: string]: any;
}

export type WasmDatasource = SubstrateCustomDatasource<
  'substrate/Wasm',
  SubstrateNetworkFilter,
  SubstrateMapping<SubstrateCustomHandler>,
  WasmProcessorOptions
>;

export interface WasmEventFilter extends SubstrateNetworkFilter {
  from?: string;
  contract?: string;
  identifier?: IdentifierFilter;
}

export interface WasmCallFilter extends SubstrateNetworkFilter {
  // dest?: string; //Filter in processor option contract
  from?: string;
  selector?: string; //To u8a
  method?: string; // label
}

export type ContractEmittedResult = [AccountId, Bytes];

export type ContractCallArgs = [Address, BalanceOf, Weight, Option<Compact<u128>>, Bytes];

// TODO add valid_until, access_list
export interface WasmEvent<T extends Result = Result> {
  from: string;
  contract: AccountId;
  eventIndex: number;
  identifier?: string | undefined;
  args?: T | undefined;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  timestamp: Date;
}
export interface WasmCall<T extends Result = Result> {
  from: Address;
  dest: Address;
  value: BalanceOf;
  gasLimit: Weight;
  storageDepositLimit: Option<Compact<u128>>;
  data: {args: T; message: AbiMessage} | string;
  selector: string;
  success: boolean;
  hash: string;
  blockNumber: number;
  blockHash: string;
  timestamp: Date;
}

class WasmProcessorOptions {
  @IsOptional()
  abi?: string;
  @IsOptional()
  contract?: string;
}

class WasmEventFilterImpl implements WasmEventFilter {
  @IsOptional()
  @IsString()
  from?: string;
  @IsOptional()
  @IsString()
  contract?: string;
  @IsOptional()
  // @Validate(TopicFilterValidator, {each: true}) //TODO
  identifier?: IdentifierFilter;
}

class WasmCallFilterImpl implements WasmCallFilter {
  @IsOptional()
  @IsString()
  dest?: string;
  @IsString()
  @IsOptional()
  selector?: string;
  @IsString()
  @IsOptional()
  method?: string; // label
}

const dsAssets: Record<string, string> = {};
// used abi name with its ABI object will be stored
const contractAbis: Record<string, Abi> = {};
//only single event will be stored, reset if encounter new event
let decodedEvent: Record<string, DecodedEvent> = {};
//only single message will be stored, reset if encounter new message
let decodedMessage: Record<string, DecodedMessage> = {};
//get identifier index from abi json, in order construct dictionary query
const eventIndexes: Record<string, number> = {};
const methodSelectors: Record<string, string> = {};
export async function getDsAssets(ds: WasmDatasource, abi: string): Promise<string> {
  if (!isCustomDs(ds)) {
    throw new Error(`data source is not a custom data source`);
  }
  const assetFile = ds.assets?.get(abi);
  if (!assetFile) {
    throw new Error(`Abi named "${abi}" not referenced in assets`);
  }
  if (!dsAssets[abi]) {
    try {
      // console.log(`read asset from file once`)
      dsAssets[abi] = fs.readFileSync(assetFile.file, {
        encoding: 'utf8',
      });
    } catch (e) {
      console.error(`Failed to load datasource asset ${assetFile.file}`);
      throw e;
    }
  }
  return dsAssets[abi];
}
export async function buildAbi(ds: WasmDatasource): Promise<Abi | undefined> {
  const abi = ds.processor?.options?.abi;
  if (!abi || !ds.assets) {
    return;
  }
  // This assumes that all datasources have a different abi name or they are the same abi
  if (!contractAbis[abi]) {
    // Constructing the interface validates the ABI
    try {
      const asset = await getDsAssets(ds, abi);
      const abiObj = JSON.parse(asset);
      contractAbis[abi] = new Abi(abiObj);
    } catch (e) {
      (global as any).logger.error(e, `Unable to parse contract metadata`);
      throw new Error('Contract metadata is invalid');
    }
  }
  return contractAbis[abi];
}
export function decodeEvent(data: Bytes, iAbi?: Abi): DecodedEvent | undefined {
  if (decodedEvent[data.toString()]) {
    return decodedEvent[data.toString()];
  } else {
    //if no matches, empty previous decode events, add for current data
    decodedEvent = {};
    if (!iAbi) {
      throw new Error(`Decode event failed, got abi undefined`);
    }
    decodedEvent[data.toString()] = iAbi?.decodeEvent(u8aToU8a(data));
  }
  return decodedEvent[data.toString()];
}
export function decodeMessage(data: Uint8Array, iAbi?: Abi): DecodedMessage {
  if (decodedMessage[data.toString()]) {
    return decodedMessage[data.toString()];
  } else {
    //if no matches, empty previous decode messages, add for current data
    decodedMessage = {};
    if (!iAbi) {
      throw new Error(`Decode message failed, got abi undefined`);
    }
    decodedMessage[data.toString()] = iAbi?.decodeMessage(data);
  }
  return decodedMessage[data.toString()];
}
export async function getEventIndex(identifier: string, ds: WasmDatasource): Promise<number | undefined> {
  if (eventIndexes[identifier]) {
    return eventIndexes[identifier];
  } else {
    const abi = ds.processor.options?.abi;
    if (!abi) {
      throw new Error(`Abi must be provided to get event index`);
    }
    const asset = await getDsAssets(ds, abi);
    const abiObj = JSON.parse(asset) as unknown as JSONAbi;
    const eventIndex = (abiObj.V4 || abiObj.V3 || abiObj.V2 || abiObj.V1 || abi).spec.events.findIndex(
      (event) => event.label === identifier
    );
    if (eventIndex > -1) {
      eventIndexes[identifier] = eventIndex;
    } else {
      return;
    }
  }
  return eventIndexes[identifier];
}
export async function methodToSelector(method: string, ds: WasmDatasource): Promise<string | undefined> {
  if (methodSelectors[method]) {
    return methodSelectors[method];
  } else {
    const abi = ds.processor.options?.abi;
    if (!abi) {
      throw new Error(`Abi must be provided to find message and its selector`);
    }
    const asset = await getDsAssets(ds, abi);
    const abiObj = JSON.parse(asset) as unknown as JSONAbi;
    const message = (abiObj.V4 || abiObj.V3 || abiObj.V2 || abiObj.V1 || abi).spec.messages.find(
      (message) => message.label === method
    );
    if (message !== undefined) {
      methodSelectors[method] = message.selector;
    } else {
      return;
    }
  }
  return methodSelectors[method];
}
export function getSelector(data: Uint8Array): string {
  //This should align with https://github.com/polkadot-js/api/blob/0b6f7861080c920407a346e2a3dbe64adcb07a1e/packages/api-contract/src/Abi/index.ts#L249
  const [, trimmed] = compactStripLength(data);
  return u8aToHex(trimmed.subarray(0, 4));
}

const EventProcessor: SecondLayerHandlerProcessor_1_0_0<
  SubstrateHandlerKind.Event,
  WasmEventFilter,
  WasmEvent,
  ContractEmittedResult,
  WasmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'contracts', method: 'ContractEmitted'}], // TODO executed failed
  baseHandlerKind: SubstrateHandlerKind.Event,

  // eslint-disable-next-line @typescript-eslint/require-await
  async transformer({ds, filter, input: original}): Promise<WasmEvent[]> {
    const from = original.extrinsic ? original.extrinsic.extrinsic.signer.toString() : EMPTY_ADDRESS;
    const [contract, data] = original.event.data;
    let decodedData: DecodedEvent | undefined;
    try {
      const iAbi = await buildAbi(ds);
      decodedData = decodeEvent(data, iAbi);
      if (decodedData === undefined) {
        (global as any).logger?.warn(
          `Unable to decode wasm event ${original.block.block.header.number}-${
            original.event.index
          }, with data ${data.toString()}`
        );
      }
    } catch (e) {
      // TODO setup ts config with global defs
      (global as any).logger?.warn(`Unable to parse event data,${e}`);
    }

    return [
      {
        blockNumber: original.block.block.header.number.toNumber(),
        blockHash: original.block.block.header.hash.toHex(),
        transactionHash: original.hash.toString(),
        timestamp: original.block.timestamp,
        from,
        contract: contract,
        //align with https://github.com/polkadot-js/api/blob/0b6f7861080c920407a346e2a3dbe64adcb07a1e/packages/api-contract/src/Abi/index.ts#L125
        eventIndex: data[0],
        identifier: decodedData?.event.identifier,
        args: decodedData?.args,
      },
    ];
  },
  async filterProcessor({ds, filter, input}): Promise<boolean> {
    const [contract, data] = input.event.data;
    if (ds.processor?.options?.contract && !stringNormalizedEq(ds.processor.options.contract, contract.toString())) {
      return false;
    }
    if (filter?.identifier) {
      const iAbi = await buildAbi(ds);
      const decoded = decodeEvent(data, iAbi);

      const determine = decoded?.event.identifier === filter.identifier;
      return determine;
    }
    return true;
  },
  filterValidator(filter?: WasmEventFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(WasmEventFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid WASM event filter.\n${errorMsgs}`);
    }
  },
  async dictionaryQuery(filter: WasmEventFilter, ds: WasmDatasource): Promise<DictionaryQueryEntry | undefined> {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'contractEmitted',
      conditions: [],
    };
    if (ds.processor?.options?.contract) {
      queryEntry.conditions.push({field: 'contract', value: ds.processor.options.contract.toLowerCase()});
    } else {
      return;
    }
    if (filter?.from) {
      queryEntry.conditions.push({field: 'from', value: filter.from});
    }
    // TODO, in order extract identifier will require abi/metadata
    if (filter?.identifier) {
      const eventIndex = await getEventIndex(filter.identifier, ds);
      if (eventIndex === undefined) {
        (global as any).logger?.warn(
          `Unable to locate identifier ${filter?.identifier} in abi, will be omitted from dictionary filter`
        );
      } else {
        queryEntry.conditions.push({field: 'eventIndex', value: eventIndex.toString()});
      }
    }
    return queryEntry;
  },
};

const CallProcessor: SecondLayerHandlerProcessor_1_0_0<
  SubstrateHandlerKind.Call,
  WasmCallFilter,
  WasmCall,
  ContractCallArgs,
  WasmDatasource
> = {
  specVersion: '1.0.0',
  baseFilter: [{module: 'contracts', method: 'call'}],
  baseHandlerKind: SubstrateHandlerKind.Call,
  // eslint-disable-next-line @typescript-eslint/require-await
  async transformer({ds, input: original}): Promise<[WasmCall]> {
    const [dest, value, gasLimit, storageDepositLimit, data] = original.extrinsic.method.args;

    const success = !original.events.find(
      (evt) => evt.event.section === 'system' && evt.event.method === 'ExtrinsicFailed'
    );
    let decodedMessage: DecodedMessage | undefined;
    try {
      const iAbi = await buildAbi(ds);
      decodedMessage = decodeMessage(data.toU8a(), iAbi);
    } catch (e) {
      // TODO setup ts config with global defs
      (global as any).logger?.warn(`Unable to parse call arguments, will be omitted from result`);
    }

    const call: WasmCall = {
      // Transaction properties
      from: original.extrinsic.signer,
      dest: dest,
      value: value,
      gasLimit: gasLimit,
      storageDepositLimit: storageDepositLimit as Option<Compact<u128>>,
      // if unable to decode, return as string
      data: decodedMessage ? {args: decodedMessage?.args, message: decodedMessage.message} : data.toHex(),
      success,
      selector: getSelector(data.toU8a()),
      // Transaction response properties
      hash: original.extrinsic.hash.toHex(), // Substrate extrinsic hash
      blockNumber: original.block.block.header.number.toNumber(),
      blockHash: original.block.block.hash.toHex(), // Substrate block hash
      timestamp: original.block.timestamp,
    };
    return [call];
  },
  async filterProcessor({ds, filter, input}): Promise<boolean> {
    try {
      const [dest, , , , data] = input.extrinsic.args;
      const iAbi = await buildAbi(ds);
      const from = input.extrinsic.signer.toString();

      if (filter?.from && !stringNormalizedEq(filter.from, from)) {
        return false;
      }
      if (
        ds.processor?.options?.contract &&
        !stringNormalizedEq(ds.processor?.options?.contract, (dest as Address).toString())
      ) {
        return false;
      }
      const decodedMessage = decodeMessage(data.toU8a(), iAbi);
      if (filter?.method && !stringNormalizedEq(filter.method, decodedMessage?.message.method)) {
        return false;
      }
      if (filter?.selector && !stringNormalizedEq(filter.selector, decodedMessage?.message.selector.toString())) {
        return false;
      }
      return true;
    } catch (e) {
      (global as any).logger?.warn('Unable to properly filter input');
      return false;
    }
  },
  filterValidator(filter?: WasmCallFilter): void {
    if (!filter) return;
    const filterCls = plainToClass(WasmCallFilterImpl, filter);
    const errors = validateSync(filterCls, {whitelist: true, forbidNonWhitelisted: true});

    if (errors?.length) {
      const errorMsgs = errors.map((e) => e.toString()).join('\n');
      throw new Error(`Invalid Wasm call filter.\n${errorMsgs}`);
    }
  },
  async dictionaryQuery(filter: WasmCallFilter, ds: WasmDatasource): Promise<DictionaryQueryEntry | undefined> {
    const queryEntry: DictionaryQueryEntry = {
      entity: 'contractsCall',
      conditions: [],
    };
    // contract <----> call.dest
    if (ds.processor?.options?.contract) {
      queryEntry.conditions.push({field: 'dest', value: ds.processor.options.contract.toLowerCase()});
    }
    if (filter?.selector) {
      queryEntry.conditions.push({field: 'selector', value: filter.selector});
    }
    if (filter?.method) {
      const selector = await methodToSelector(filter.method, ds);
      if (selector === undefined) {
        (global as any).logger?.warn(
          `Unable to locate method ${filter.method} in abi, will be omitted from dictionary filter`
        );
      } else if (filter?.selector && filter.selector !== selector) {
        (global as any).logger?.warn(
          `Got both selector and method ${filter?.method} defined in call filters , method decoded selector is ${selector}, which is not match with selector ${filter?.selector}. Only selector will be apply to dictionary `
        );
      } else {
        queryEntry.conditions.push({field: 'selector', value: selector});
      }
    }
    return queryEntry;
  },
};

export const WasmDatasourcePlugin = <
  SubstrateDatasourceProcessor<
    'substrate/Wasm',
    SubstrateNetworkFilter,
    WasmDatasource,
    {
      'substrate/WasmEvent': typeof EventProcessor;
      'substrate/WasmCall': typeof CallProcessor;
    }
  >
>{
  kind: 'substrate/Wasm',
  async validate(ds: WasmDatasource, assets: Record<string, string>): Promise<void> {
    if (ds.processor.options) {
      const opts = plainToClass(WasmProcessorOptions, ds.processor.options);
      const errors = validateSync(opts, {whitelist: true, forbidNonWhitelisted: true});
      if (errors?.length) {
        const errorMsgs = errors.map((e) => e.toString()).join('\n');
        throw new Error(`Invalid Wasm call filter.\n${errorMsgs}`);
      }
    }
    await buildAbi(ds); // Will throw if unable to construct
    return;
  },
  dsFilterProcessor(ds: WasmDatasource): boolean {
    return ds.kind === this.kind;
  },
  handlerProcessors: {
    'substrate/WasmEvent': EventProcessor,
    'substrate/WasmCall': CallProcessor,
  },
};

export default WasmDatasourcePlugin;
