<script setup lang="ts">
import { onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    baseUrl?: string;
  }>(),
  {
    baseUrl: "/api/auth",
  },
);

const authChecked = ref(false);
const authenticated = ref(true);
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);

onMounted(async () => {
  try {
    const res = await fetch(`${props.baseUrl}/status`);
    if (res.ok) {
      const data = (await res.json()) as { authRequired?: boolean; authenticated?: boolean };
      authenticated.value = !data.authRequired || Boolean(data.authenticated);
    }
  } catch {
    authenticated.value = true;
  } finally {
    authChecked.value = true;
  }
});

async function submitLogin() {
  if (!password.value || loggingIn.value) return;
  loggingIn.value = true;
  loginError.value = "";
  try {
    const res = await fetch(`${props.baseUrl}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      loginError.value = data.error ?? "Login failed";
      return;
    }
    password.value = "";
    authenticated.value = true;
  } catch {
    loginError.value = "Network error";
  } finally {
    loggingIn.value = false;
  }
}
</script>

<template>
  <div
    v-if="authChecked && !authenticated"
    class="flex h-screen w-screen items-center justify-center bg-neutral-950 text-neutral-100"
  >
    <form
      class="flex w-80 flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl"
      @submit.prevent="submitLogin"
    >
      <h1 class="text-base font-medium">Harness Login</h1>
      <input
        v-model="password"
        type="password"
        placeholder="Password"
        autofocus
        class="rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-blue-500"
      />
      <p v-if="loginError" class="text-xs text-red-400">{{ loginError }}</p>
      <button
        type="submit"
        :disabled="loggingIn"
        class="rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
      >
        {{ loggingIn ? "Signing in..." : "Sign in" }}
      </button>
    </form>
  </div>
  <slot v-else-if="authChecked" />
</template>
