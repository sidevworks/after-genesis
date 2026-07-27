import { hashValue, HashDomain } from "@after-genesis/core";
import type { ModelProvider } from "@after-genesis/core";
import { ProposedActionSchema, ACTION_TYPES } from "@after-genesis/core/schema/action-spec";
export const x: ModelProvider | null = null;
export const y = hashValue(HashDomain.ModelResponse, "hi");
export const z = ProposedActionSchema.safeParse({ type: ACTION_TYPES[0], payload: {} }).success;
