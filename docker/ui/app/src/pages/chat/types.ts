/**
 * Local types + layout constants for the Chat feature.
 *
 * Page-global chat types (Conversation, Message, ChatEvent) live in
 * `src/types/chat.ts` — only feature-local layout values belong here.
 */

/** Conversation-list pane width inside the chat frame. */
export const LIST_PANE_WIDTH = 300;

/** Which placeholder the empty thread pane should render. */
export type PlaceholderVariant = 'empty' | 'none';
