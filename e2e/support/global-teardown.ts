import { deleteTestMail } from './helpers.js';

export default async function globalTeardown(): Promise<void> {
  await deleteTestMail();
}
