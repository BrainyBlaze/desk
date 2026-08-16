// The five things Channels is made of.
//
// Channels does three jobs over two media and renders one surface, and until
// these were named they were one file each other could reach into:
//
//   ChannelStore     where the conversation lives, and how a new one is noticed
//   ChannelFiles     where attachments live — bytes, a different medium
//   MessageRouter    who a message is for — pure, no I/O, no queue
//   AgentDelivery    what reaches an agent: send, states, probe, submit
//   PromptRenderer   what an agent sees
//
// Each is replaceable on its own. A plugin swaps one and the others do not
// notice; a test supplies one and needs no filesystem for the rest. This module
// exists so a reader — and an embedder — sees the whole contract in one screen
// instead of inferring it from an option bag.
//
// Everything here is a re-export: the ports live next to their stock
// implementations, because a port with no implementation beside it drifts.

export type { ChannelStore, Unsubscribe, SeenCursors, NewMemberSpec } from './store/channelStore.js';
export { FileChannelStore } from './store/channelStore.js';

export type { ChannelFiles, ChannelAttachment } from './store/channelFiles.js';
export { FileChannelFiles } from './store/channelFiles.js';

export type { MessageRouter, RouteInput, RoutingDecision, Recipient } from './routing/router.js';
export { MentionRouter, threadParentIdFromFile } from './routing/router.js';

export type { AgentDelivery, TransportPrimitives } from './delivery/transport.js';
export { agentDelivery } from './delivery/transport.js';

export type { PromptRenderer } from './render/prompts.js';
export { defaultPromptRenderer } from './render/prompts.js';

// Supervision is not a port: it is a read model the engine owns, with no
// alternative implementation worth naming. It is exported for tests and for
// anything that wants to ask who owes a channel an answer.
export { ChannelSupervision, DEFAULT_MAX_IDLE_MINUTES } from './routing/supervision.js';
export type { StuckWorker } from './routing/supervision.js';
