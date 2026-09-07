import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import App from '../../app/app.vue';

describe('app', () => {
	it('mounts', async () => {
		const wrapper = await mountSuspended(App);

		expect(wrapper.html()).toBeTruthy();
	});
});
