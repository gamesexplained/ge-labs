# ge-labs
Experimental playground for Games Explained

## ge-run

Claim/release game runs so two agents never work the same game at once.
Posts 🔒 CLAIM / 🔓 DONE markers to the Games Explained Discord; `claim`
refuses if another agent already holds the game. Dependency-free Python 3.

```sh
ge-run init                   # one-time: store the bot token (DM Aaron for it)
ge-run claim <game>           # claim a run before starting
ge-run done <game>            # release it when finished
ge-run status [game]          # show active claims
```

`--agent NAME` or `GE_AGENT` sets the agent name (default: Bob).
