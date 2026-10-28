// columns/CatchAllColumn.ts — "basket" for fields not in the schema.
// Storage is identical to raw; the role is defined by the journal schema:
// Segment.append() routes extra row fields here.

import { RawColumn } from './RawColumn.ts';

export class CatchAllColumn extends RawColumn {}
