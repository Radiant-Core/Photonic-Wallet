// Type declarations for radiantswap module
// This provides basic type information to resolve TypeScript errors

export interface Market {
  createTxid: string;
  question: string;
  marketRef: string;
  yesRef: string;
  noRef: string;
  expiry: number;
  grace: number;
  oracle: string;
  committeeKeys: string[];
  threshold: number;
  optimistic?: {
    bond: number;
    liveness: number;
  };
  addedAt: number;
  kind?: string;
  outcomeRefs?: string[];
  outcomeLabels?: string[];
  scalar?: any;
}

export interface PredictionParams {
  question: string;
  expiry: number;
  grace: number;
  kind?: string;
  labels?: string[];
  scalar?: any;
}

export interface OracleState {
  oracle: Buffer;
  optimistic?: {
    bond: number;
    liveness: number;
  };
}

export interface MarketRefs {
  marketRef: Buffer;
  yesRef: Buffer;
  noRef: Buffer;
  outcomeRefs: Buffer[];
}

export interface CreatedMarket {
  txid: string;
  state: OracleState;
  refs: MarketRefs;
}

export interface Committee {
  keys: Buffer[];
  threshold: number;
}

// Export commonly used functions
export function createMarket(params: PredictionParams): Promise<CreatedMarket>;
export function createScalarAction(params: PredictionParams): Promise<CreatedMarket>;
export function getOdds(market: Market): Promise<number[]>;
export function calculatePayouts(market: Market, outcomes: boolean[]): Promise<number[]>;
