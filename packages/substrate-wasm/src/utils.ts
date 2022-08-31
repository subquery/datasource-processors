// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import {EventFragment, FunctionFragment} from '@ethersproject/abi';
import {isHexString, hexStripZeros, hexDataSlice} from '@ethersproject/bytes';
import {id} from '@ethersproject/hash';

export function stringNormalizedEq(a?: string, b?: string): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}
