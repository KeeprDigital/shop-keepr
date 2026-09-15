import { readHealth } from '../../services/health';

export default defineEventHandler(event => readHealth(useDb(event)));
