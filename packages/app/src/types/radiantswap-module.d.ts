// Module declaration for radiantswap
declare module "radiantswap" {
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
  
  // Additional exports used in the codebase
  export function buildCreateMarket(params: any): any;
  export function buildStatefulOutput(marker: any, script: any): any;
  export function buildMarketScripts(params: any): any;
  export function impliedProbability(odds: number[]): number;
  export function unspentByScript(script: any, ref: any): any;
  export function walletPkh(): string;
  
  // Build functions
  export function buildDispute(params1: any, params2: any, params3: any): any;
  export function buildFinalize(params1: any, params2: any): any;
  export function buildPropose(params1: any, params2: any): any;
  export function buildRevert(params1: any, params2: any): any;
  export function buildResolve(params1: any, params2: any): any;
  export function buildRedeem(params1: any, params2: any): any;
  export function buildMerge(params1: any, params2: any): any;
  export function buildSplit(params1: any, params2: any): any;
  export function buildDisputeTimeout(params1: any, params2: any, params3: any): any;
  
  // Order functions
  export function buildBuyOrder(params1: any, params2: any): any;
  export function buildSellOrder(params1: any, params2: any): any;
  export function fillBuyOrder(params1: any, params2: any): any;
  export function fillSellOrder(params1: any, params2: any): any;
  
  // Utility functions
  export function marketStateFromScript(script: any): any;
  export function minBondFor(amount: any): any;
  export function encodeState(state: any): any;
  export function encodeRef(ref: any): any;
  export function encodeCatState(state: any): any;
  export function findMarketBeacon(params1: any, params2: any): any;
  export function verifyMarketBeacon(params1: any, params2: any): any;
  export function buildShareTransfer(params1: any, params2: any): any;
  
  // Oracle and other exports
  export const oracle: any;
  export const rswp: any;
  
  // Categorical-specific functions
  export function buildCreateCategorical(params: any): any;
  export function buildCategoricalSplit(params: any): any;
  export function buildCategoricalMerge(params: any): any;
  export function buildCategoricalRedeem(params: any): any;
  export function buildCategoricalResolve(params: any): any;
  export function buildCategoricalRevert(params: any): any;
  export function buildCategoricalScripts(params: any): any;
  
  // Types and constants
  export interface Utxo {
    txid: string;
    vout: number;
    script: string;
    value: number;
    satoshis: number;
    height?: number;
    spent?: number;
  }
  
  export interface MarketState {
    status: Status;
    oracle: Buffer;
    optimistic?: any;
  }
  
  export interface MarketScripts {
    outcomeCodes: Buffer[];
    marker: Buffer;
  }
  
  // Additional interfaces
  export interface CatState {
    status: Status;
    oracle: Buffer;
    optimistic?: any;
  }
  
  export interface CatScripts {
    outcomeCodes: Buffer[];
    marker: Buffer;
  }
  
  export interface CatRefs {
    marketRef: Buffer;
    yesRef: Buffer;
    noRef: Buffer;
    outcomeRefs: Buffer[];
  }
  
  export interface BuyOrder {
    txid: string;
    vout: number;
    script: string;
    value: number;
    satoshis: number | { satoshis: number };
    shareOut?: number;
    rxd?: number;
  }
  
  export interface SellOrder {
    txid: string;
    vout: number;
    script: string;
    value: number;
    satoshis: number | { satoshis: number };
    payment?: number;
    share?: number;
  }
  
  export interface Proposal {
    txid: string;
    outcome: number;
    proposer: Buffer;
    bond: number;
  }
  
  export interface Outcome {
    index: number;
    label: string;
    payout: number;
  }
  
  export interface KeyedUtxo extends Utxo {
    key: string;
  }
  
  // Constants
  export const SUPPORTED_K: number;
  export const binLabel: (index: number) => string;
  export const binIndexForValue: (value: number, min: number, max: number, bins: number) => number;
  export const uniformRange: (min: number, max: number, bins: number) => number[];
  
  export enum Status {
    OPEN = 'open',
    CLOSED = 'closed',
    RESOLVED = 'resolved',
    REVERTED = 'reverted',
    PROPOSED_YES = 'proposed_yes',
    PROPOSED_NO = 'proposed_no',
    RESOLVED_YES = 'resolved_yes',
    RESOLVED_NO = 'resolved_no'
  }
  
  export const MAX_QUESTION_BYTES = 255;
  export const CAT_REVERTED = 'reverted';
  export const CAT_OPEN = 'open';
  export const MARKER = Buffer.from('predict', 'hex');
  export const NO_PROPOSER = Buffer.alloc(33, 0);
  
  // Additional functions
  export function trackMarket(market: Market): Promise<void>;
  export function getTrackedMarkets(): Promise<Market[]>;
  export function updateMarketStatus(market: Market, status: Status): Promise<void>;
}
