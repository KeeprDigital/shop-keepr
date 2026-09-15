import type { SearchOptions } from '../../../../shared/contracts/staff/search';
import * as z from 'zod';
import { readSearchOptions } from '../../../search/options';

/** What the Lookup filter controls are built from, for one Game System. */
export default defineEventHandler(async (event): Promise<SearchOptions> => {
	const { game } = validateQuery(event, z.object({ game: z.string().trim().min(1) }));
	const options = await readSearchOptions(useD1(event), game);
	if (!options) {
		throw apiError('NOT_FOUND', { message: `No Game System ${game}` });
	}
	return options;
});
