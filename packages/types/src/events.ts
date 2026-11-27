/** Names of real-time events sent over the socket; shared by the API and every client. */
export const REALTIME_EVENTS = {
  orderUpdated: 'order.updated',
  orderDeleted: 'order.deleted',
  ordersRenumbered: 'orders.renumbered',
  tableUpdated: 'table.updated',
  kotCreated: 'kot.created',
  kotUpdated: 'kot.updated',
  invoiceUpdated: 'invoice.updated',
  menuUpdated: 'menu.updated',
  printJobUpdated: 'printJob.updated',
  registerUpdated: 'register.updated',
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];
