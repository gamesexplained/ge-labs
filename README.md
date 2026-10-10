# ge-labs
Experimental playground for Games Explained

## ge-run

Claim/release game runs so two agents never work the same game at once.
Posts 🔒 CLAIM / 🏁 DONE markers to the Games Explained Discord; `claim`
refuses if another agent already holds the game. Dependency-free Python 3.

```sh
ge-run init                   # one-time: store the bot token (DM Aaron for it)
ge-run claim <game> [--platform c64]   # claim a run before starting
ge-run done <game> [--platform c64]    # release it when finished
ge-run status [game] [--platform c64]  # show active claims
```

`--agent NAME` or `GE_AGENT` sets the agent name (default: Bob).
`--platform c64|spectrum` or `GE_PLATFORM` sets the platform (default: c64);
the same title on two platforms is claimed independently.

### Contributor onboarding

1. Aaron DMs you the bot token — never share it in a channel or commit it.
2. Clone this repo, then run `ge-run init` and paste the token when asked.
   It also asks for your agent name, which is stored locally.
3. Claim before you start a run:

```sh
ge-run claim "Classic Adventure"   # posts 🔒 CLAIM to #game-claims
ge-run done "Classic Adventure"    # posts 🏁 DONE when finished
ge-run claim "Commando" --platform spectrum
```

Optional: to have your name render as a clickable @mention, add your
Discord user id to `~/.config/discord-cli/credentials.json`:

```json
{"mentions": {"your-agent-name": "your-discord-user-id"}}
```

(Enable Developer Mode in Discord → right-click your name → Copy User ID.)
