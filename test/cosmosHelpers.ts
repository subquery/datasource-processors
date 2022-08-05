import * as fs from 'fs';
import * as path from 'path';
import * as protobuf from 'protobufjs';
import {GeneratedType, DecodeObject, Registry} from '@cosmjs/proto-signing';
import {CustomModule} from '@subql/types-cosmos';
import {CosmosBlock, CosmosTransaction, CosmosMessage, CosmosEvent} from '@subql/types-cosmos';
import {sha256} from '@cosmjs/crypto';
import {toHex} from '@cosmjs/encoding';
import {decodeTxRaw} from '@cosmjs/proto-signing';
import {Tendermint34Client} from '@cosmjs/tendermint-rpc';
import {Block} from '@cosmjs/stargate';
import {Log, parseRawLog} from '@cosmjs/stargate/build/logs';
import {BlockResultsResponse, TxData} from '@cosmjs/tendermint-rpc';
import {CosmWasmClient} from '@cosmjs/cosmwasm-stargate';
export function decodeMsg<T = unknown>(msg: DecodeObject, registry: Registry): T {
  try {
    const decodedMsg = registry.decode(msg);
    if (
      [
        '/cosmwasm.wasm.v1.MsgExecuteContract',
        '/cosmwasm.wasm.v1.MsgMigrateContract',
        '/cosmwasm.wasm.v1.MsgInstantiateContract',
      ].includes(msg.typeUrl)
    ) {
      decodedMsg.msg = JSON.parse(new TextDecoder().decode(decodedMsg.msg));
    }
    return decodedMsg;
  } catch (e) {
    logger.error(e, 'Failed to decode message');
    throw e;
  }
}

export function wrapBlock(block: Block, txs: TxData[]): CosmosBlock {
  return {
    block: block,
    txs: txs,
  };
}

export function wrapTx(block: CosmosBlock, txResults: TxData[]): CosmosTransaction[] {
  return txResults.map((tx, idx) => ({
    idx,
    block: block,
    tx,
    hash: toHex(sha256(block.block.txs[idx])).toUpperCase(),
    get decodedTx(): any {
      delete (this as any).decodedTx;
      return ((this.decodedTx as any) = decodeTxRaw(block.block.txs[idx]));
    },
  }));
}

function wrapCosmosMsg(block: CosmosBlock, tx: CosmosTransaction, idx: number, registry: Registry): CosmosMessage {
  const rawMessage = tx.decodedTx.body.messages[idx];
  return {
    idx,
    tx: tx,
    block: block,
    msg: {
      typeUrl: rawMessage.typeUrl,
      get decodedMsg() {
        delete this.decodedMsg;
        return (this.decodedMsg = decodeMsg(rawMessage, registry));
      },
    },
  };
}

function wrapMsg(block: CosmosBlock, txs: CosmosTransaction[], registry: Registry): CosmosMessage[] {
  const msgs: CosmosMessage[] = [];
  for (const tx of txs) {
    for (let i = 0; i < tx.decodedTx.body.messages.length; i++) {
      msgs.push(wrapCosmosMsg(block, tx, i, registry));
    }
  }
  return msgs;
}

export function wrapEvent(block: CosmosBlock, txs: CosmosTransaction[], registry: Registry): CosmosEvent[] {
  const events: CosmosEvent[] = [];
  for (const tx of txs) {
    let logs: Log[];
    try {
      logs = parseRawLog(tx.tx.log) as Log[];
    } catch (e) {
      //parsing fails if transaction had failed.
      logger.warn('Failed to parse raw log, most likely a failed transaction');
      continue;
    }
    for (const log of logs) {
      const msg = wrapCosmosMsg(block, tx, log.msg_index, registry);
      for (let i = 0; i < log.events.length; i++) {
        const event: CosmosEvent = {
          idx: i,
          msg,
          tx,
          block,
          log,
          event: log.events[i],
        };
        events.push(event);
      }
    }
  }

  return events;
}

async function getBlockByHeight(
  api: CosmWasmClient,
  tm: Tendermint34Client,
  height: number
): Promise<[Block, BlockResultsResponse]> {
  return Promise.all([
    api.getBlock(height).catch((e) => {
      logger.error(e, `failed to fetch block info ${height}`);
      throw e;
    }),
    tm.blockResults(height).catch((e) => {
      logger.error(e, `failed to fetch block results ${height}`);
      throw e;
    }),
  ]);
}

export async function fetchBlock(
  api: CosmWasmClient,
  tm: Tendermint34Client,
  registry: Registry,
  blockNumber: number
): Promise<{
  block: CosmosBlock;
  txs: CosmosTransaction[];
  messages: CosmosMessage<any>[];
  events: CosmosEvent[];
}> {
  const [blockInfo, blockResults] = await getBlockByHeight(api, tm, blockNumber);
  const results = [...blockResults.results];
  const block = wrapBlock(blockInfo, results);
  const txs = wrapTx(block, results);
  const messages = wrapMsg(block, txs, registry);
  const events = wrapEvent(block, txs, registry);

  return {block, txs, messages, events};
}

export type CosmosChainType = CustomModule & {
  proto: protobuf.Root;
  packageName?: string;
};

export async function getFile(fileName: string): Promise<string | undefined> {
  console.log(`fetching ${fileName}`);
  if (!fs.existsSync(fileName)) {
    return Promise.resolve(undefined);
  }
  try {
    return fs.readFileSync(fileName, 'utf-8');
  } catch (e) {
    return undefined;
  }
}

export async function processChainTypes(
  protos: any
): Promise<Map<string, CosmosChainType> & {protoRoot: protobuf.Root}> {
  const chainTypes = new Map<string, CosmosChainType>() as Map<string, CosmosChainType> & {protoRoot: protobuf.Root};

  const protoRoot = new protobuf.Root();
  for (const [key, value] of protos) {
    const [packageName, proto] = await loadNetworkChainType(value.file);
    chainTypes.set(key, {...value, packageName, proto});

    protoRoot.add(proto);
  }
  chainTypes.protoRoot = protoRoot;
  return chainTypes;
}

export async function loadNetworkChainType(file: string): Promise<[string | undefined, protobuf.Root]> {
  const proto = await getFile(path.resolve(__dirname, '../packages/ethermint-evm/src', file));

  if (!proto) throw new Error(`Unable to load chain type from ${file}`);

  const {package: packageName, root} = protobuf.parse(proto);

  return [packageName, root];
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function getChainType(
  chainTypes: Map<string, CosmosChainType> & {protoRoot: protobuf.Root}
): Promise<Record<string, GeneratedType>> {
  const res: Record<string, GeneratedType> = {};
  for (const [userPackageName, {messages, packageName}] of chainTypes) {
    const pkgName = packageName ?? userPackageName;
    for (const msg of messages) {
      logger.info(`Registering chain message type "/${pkgName}.${msg}"`);
      const msgObj = chainTypes.protoRoot.lookupType(`${pkgName}.${msg}`);
      res[`/${pkgName}.${msg}`] = msgObj;
    }
  }
  return res;
}
