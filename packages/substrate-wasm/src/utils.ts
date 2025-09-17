// Copyright 2020-2025 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {SubstrateCustomDatasource, SubstrateDatasource, SubstrateDatasourceKind} from '@subql/types';

export function stringNormalizedEq(a?: string, b?: string): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}

export function isCustomDs(ds: SubstrateDatasource): ds is SubstrateCustomDatasource<string> {
  return ds.kind !== SubstrateDatasourceKind.Runtime && !!(ds as SubstrateCustomDatasource<string>).processor;
}
