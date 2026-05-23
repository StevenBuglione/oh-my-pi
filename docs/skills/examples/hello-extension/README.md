# hello-extension

A minimal `oh-my-gpt` extension that demonstrates the two most common authoring patterns: subscribing to `session_start` to notify on load, and registering a `/hello` slash command that sends a greeting into the conversation. It is intentionally small — use it as a copy-paste starting point for your own extension.

## Install

**Option A — drop into user extensions directory:**

```
cp -r . ~/.omg/agent/extensions/hello-extension
```

Restart `omg`. You will see the startup notification immediately.

**Option B — point the settings `extensions` array at it:**

```yaml
# ~/.omg/agent/config.yml
extensions:
  - /path/to/hello-extension
```

**Option C — load once via CLI flag:**

```
omg --extension ./hello-extension
```

## Usage

After loading, type `/hello` in the omg prompt to trigger the notification.

## What it demonstrates

- Default export factory receiving `ExtensionAPI`
- `pi.on("session_start", ...)` — session lifecycle hook
- `pi.registerCommand(...)` — slash command registration
- `ctx.ui.notify(...)` — user-facing notification
- `package.json` with `omg.extensions` manifest field
