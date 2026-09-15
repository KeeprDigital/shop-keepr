<script setup lang="ts">
import type { FormSubmitEvent } from '@nuxt/ui';
import * as z from 'zod';

definePageMeta({ layout: 'auth' });

const schema = z.object({
	email: z.email('Enter the store login email'),
	password: z.string().min(1, 'Enter the password'),
});
type Schema = z.output<typeof schema>;

const fields = [
	{ name: 'email', type: 'email' as const, label: 'Email', placeholder: 'Store login', autocomplete: 'username' },
	{ name: 'password', type: 'password' as const, label: 'Password', autocomplete: 'current-password' },
];

const failure = ref<string | null>(null);
const loading = ref(false);

async function onSubmit({ data }: FormSubmitEvent<Schema>) {
	failure.value = null;
	loading.value = true;
	const { error } = await authClient.signIn.email({ email: data.email, password: data.password });
	if (error) {
		loading.value = false;
		failure.value = error.status === 401 ? 'Wrong email or password' : (error.message ?? 'Sign-in failed');
		return;
	}
	// A full navigation: the session cookie is now set and Lookup renders with it.
	await navigateTo('/', { external: true });
}
</script>

<template>
	<UCard class="w-full max-w-sm">
		<UAuthForm
			title="shop-keepr"
			description="Sign in with the store login"
			icon="i-lucide-store"
			:schema="schema"
			:fields="fields"
			:loading="loading"
			:submit="{ label: 'Sign in' }"
			@submit="onSubmit"
		>
			<template #validation>
				<UAlert v-if="failure" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="failure" />
			</template>
		</UAuthForm>
	</UCard>
</template>
