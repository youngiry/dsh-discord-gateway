# NOTICE

## Design provenance

`dsh-discord-gateway` implements the **Hermes Agent gateway** pattern for
DeepSeek Harness. The following design elements are adapted from
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
(MIT-licensed):

- Session-key mapping: `ns:platform:chat_type:chat_id:thread_id:user_id`
  (here `discord:dm:<userId>` / `discord:guild:<guild>:<channel>[:thread:<id>]`)
- Message truncation with `（i/n）` markers, preferring line/period boundaries
- Typing-indicator refresh loop and progressive message editing during streaming
- Fail-closed authorization defaults (allowlists, deny by default)

Hermes Agent is Copyright (c) Nous Research and contributors, MIT License.

## API contracts

The plugin drives DeepSeek Harness agents through the public contracts of
`@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`
and `@deepseek-ai/dsh-agent-default-model`, all part of the MIT-licensed
[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

The community aggregate gateway
[zhuiyueya/dsh-im-gateway](https://github.com/zhuiyueya/dsh-im-gateway)
(MIT) was reviewed as a reference for the `agent.followup` + `session/event`
outbound routing approach; no code is copied from it.

## Trademarks

Discord is a trademark of Discord Inc. This project is not affiliated with or
endorsed by Discord Inc. or DeepSeek.
