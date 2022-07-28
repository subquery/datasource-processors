import {ApiPromise} from '@polkadot/api';
import {Vec} from '@polkadot/types';
import {EventRecord, SignedBlock} from '@polkadot/types/interfaces';
import {SubstrateEvent, SubstrateExtrinsic, SubstrateBlock} from '@subql/types';
import {merge} from 'lodash';

export function wrapBlock(signedBlock: SignedBlock, events: EventRecord[], specVersion: number): SubstrateBlock {
  return merge(signedBlock, {
    timestamp: getTimestamp(signedBlock),
    specVersion: specVersion,
    events,
  });
}

function getTimestamp({block: {extrinsics}}: SignedBlock): Date {
  for (const e of extrinsics) {
    const {
      method: {method, section},
    } = e;
    if (section === 'timestamp' && method === 'set') {
      const date = new Date(e.args[0].toJSON() as number);
      if (isNaN(date.getTime())) {
        throw new Error('timestamp args type wrong');
      }
      return date;
    }
  }

  throw new Error('No timestamp on block');
}

export function wrapExtrinsics(wrappedBlock: SubstrateBlock, allEvents: EventRecord[]): SubstrateExtrinsic[] {
  return wrappedBlock.block.extrinsics.map((extrinsic, idx) => {
    const events = filterExtrinsicEvents(idx, allEvents);
    return {
      idx,
      extrinsic,
      block: wrappedBlock,
      events,
      success: getExtrinsicSuccess(events),
    };
  });
}

function getExtrinsicSuccess(events: EventRecord[]): boolean {
  return events.findIndex((evt) => evt.event.method === 'ExtrinsicSuccess') > -1;
}

function filterExtrinsicEvents(extrinsicIdx: number, events: EventRecord[]): EventRecord[] {
  return events.filter(({phase}) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eqn(extrinsicIdx));
}

export function wrapEvents(
  extrinsics: SubstrateExtrinsic[],
  events: EventRecord[],
  block: SubstrateBlock
): SubstrateEvent[] {
  return events.reduce((acc, event, idx) => {
    const {phase} = event;
    const wrappedEvent: SubstrateEvent = merge(event, {idx, block});
    if (phase.isApplyExtrinsic) {
      wrappedEvent.extrinsic = extrinsics[phase.asApplyExtrinsic.toNumber()];
    }
    acc.push(wrappedEvent);
    return acc;
  }, [] as SubstrateEvent[]);
}

export async function fetchBlock(
  api: ApiPromise,
  height: number
): Promise<{
  block: SubstrateBlock;
  extrinsics: SubstrateExtrinsic[];
  events: SubstrateEvent[];
}> {
  const blockHash = await api.rpc.chain.getBlockHash(height);

  const [signedBlock, rawEvents, runtimeVersion] = await Promise.all([
    api.rpc.chain.getBlock(blockHash) as Promise<any>,
    api.query.system.events.at(blockHash) as Promise<Vec<EventRecord>>,
    api.rpc.state.getRuntimeVersion(blockHash).then((res) => res.specVersion.toNumber()),
  ]);

  const block = wrapBlock(signedBlock, rawEvents, runtimeVersion);
  const extrinsics = wrapExtrinsics(block, rawEvents);
  const events = wrapEvents(extrinsics, rawEvents, block);

  return {
    block,
    extrinsics,
    events,
  };
}
