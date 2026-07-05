import {
  Alert,
  Anchor,
  Button,
  Card,
  Center,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { signIn, signUp, workspace } from "../auth.js";

/** Slug from a name plus a short random suffix (workspace slugs must be unique). */
function wsSlug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

// Signup UI is hidden when signup is disabled server-side (AUTH_DISABLE_SIGNUP=1;
// the vite-served twin VITE_AUTH_DISABLE_SIGNUP drives this). The server flag is
// the real enforcement — this just keeps the UI honest.
const signupDisabled = import.meta.env.VITE_AUTH_DISABLE_SIGNUP === "1";

/**
 * Email/password login + signup gate. On signup we also auto-create a personal
 * workspace and make it active, so a new user lands in a usable workspace.
 * `useSession` in the host gate flips to the app once the cookie is set.
 */
export function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isSignup = mode === "signup" && !signupDisabled;

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      if (isSignup) {
        const res = await signUp.email({ email, password, name });
        if (res.error) {
          setError(res.error.message ?? "Sign up failed");
          return;
        }
        // Fresh users have no workspace — create a personal one and make it active.
        const created = await workspace.create({
          name: name ? `${name}'s Workspace` : "My Workspace",
          slug: wsSlug(name || email),
        });
        if (created.data?.id) {
          await workspace.setActive(created.data.id);
        }
      } else {
        const res = await signIn.email({ email, password });
        if (res.error) {
          setError(res.error.message ?? "Sign in failed");
          return;
        }
      }
      // Success: the useSession subscriber in <App> re-renders into the app.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Center h="100vh">
      <Card withBorder shadow="sm" radius="md" p="xl" w={380}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Stack>
            <Title order={3}>{isSignup ? "Create your account" : "Welcome back"}</Title>
            {isSignup && (
              <TextInput
                label="Name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                required
              />
            )}
            <TextInput
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.currentTarget.value)}
              required
            />
            <PasswordInput
              label="Password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}
            <Button type="submit" loading={loading} fullWidth>
              {isSignup ? "Sign up" : "Log in"}
            </Button>
            {!signupDisabled && (
              <Text size="sm" c="dimmed" ta="center">
                {isSignup ? "Already have an account? " : "No account yet? "}
                <Anchor
                  component="button"
                  type="button"
                  onClick={() => {
                    setError(null);
                    setMode(isSignup ? "login" : "signup");
                  }}
                >
                  {isSignup ? "Log in" : "Sign up"}
                </Anchor>
              </Text>
            )}
          </Stack>
        </form>
      </Card>
    </Center>
  );
}
