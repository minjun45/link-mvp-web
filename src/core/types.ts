export type Store = {
  id: string;
  name: string;
  address: string;
  hours: string;
  beaconName: string;
  description: string;
  open: boolean;
};
export type Choice = { id: string; name: string; price: number };
export type Group = {
  id: string;
  name: string;
  required: boolean;
  choices: Choice[];
};
export type Product = {
  id: string;
  name: string;
  category: string;
  price: number;
  description: string;
  note: string;
  art: string;
  popular?: boolean;
  soldOut: boolean;
  options: Group[];
};
export type Line = {
  id: string;
  productId: string;
  quantity: number;
  options: Record<string, string>;
};
export type PricedLine = {
  productId: string;
  name: string;
  quantity: number;
  options: Record<string, string>;
  labels: string[];
  unitPrice: number;
  total: number;
};
export type Quote = {
  storeId: string;
  storeName: string;
  items: PricedLine[];
  total: number;
  quantity: number;
};
export type Payment = {
  id: string;
  state:
    | 'ready'
    | 'preparing'
    | 'approving'
    | 'review'
    | 'approved'
    | 'cancelled'
    | 'failed'
    | 'expired';
  provider: string;
  snapshot: Quote;
  orderId?: string;
  redirect?: string;
  created?: number;
};
export type Order = {
  id: string;
  paymentId: string;
  number: string;
  created: number;
  snapshot: Quote;
  status: 'received' | 'preparing' | 'ready';
  demo: boolean;
};
export type Request = {
  key: string;
  storeId: string;
  items: Line[];
  expected: Quote;
};
export type Flow =
  | 'BOOT'
  | 'V5-O1'
  | 'V5-O2'
  | 'V5-O3'
  | 'V5-O4'
  | 'V5-01'
  | 'E01'
  | 'E02'
  | 'E03'
  | 'E04'
  | 'E05'
  | 'V5-02'
  | 'V5-02e'
  | 'V5-02s'
  | 'V5-03'
  | 'V5-04'
  | 'V5-R1'
  | 'V5-M1'
  | 'V5-05'
  | 'V5-05c'
  | 'V5-06'
  | 'V5-06s'
  | 'V5-M3'
  | 'V5-M4'
  | 'V5-08e'
  | 'V5-08'
  | 'V5-09'
  | 'PAYMENT_EXTERNAL'
  | 'P01-E1'
  | 'P01-E2'
  | 'P02-C'
  | 'P02-F'
  | 'P02-T'
  | 'P02-V'
  | 'V5-10'
  | 'V5-11'
  | 'V5-12'
  | 'SETTINGS';
export type Settings = {
  dark: boolean;
  contrast: boolean;
  large: boolean;
  voice: boolean;
  quickOptions: boolean;
  mode: 'local' | 'server';
  serverUrl: string;
};
export type Snapshot = {
  onboarded: boolean;
  settings: Settings;
  storeId?: string;
  cart: Line[];
  history: Record<string, Order>;
  request?: Request;
  payment?: Payment;
  order?: Order;
};
export type PreviousScreen = Pick<
  State,
  | 'flow'
  | 'selectedStoreId'
  | 'productId'
  | 'editId'
  | 'selected'
  | 'quantity'
  | 'step'
  | 'returnReview'
  | 'query'
  | 'category'
  | 'storeLimit'
  | 'menuLimit'
  | 'categoryLimit'
  | 'message'
>;
export type State = Snapshot & {
  flow: Flow;
  backStack: PreviousScreen[];
  stores: Store[];
  found: Store[];
  products: Product[];
  selectedStoreId?: string;
  productId?: string;
  selected: Record<string, string>;
  quantity: number;
  editId?: string;
  query: string;
  category: string;
  storeLimit: number;
  menuLimit: number;
  categoryLimit: number;
  step: number;
  returnReview: boolean;
  returnTo: Flow;
  discovery: 'ble' | 'demo';
  error: string;
  message: string;
  missingGroup?: string;
  changed?: Quote;
  signal?: string;
  revision: number;
};
