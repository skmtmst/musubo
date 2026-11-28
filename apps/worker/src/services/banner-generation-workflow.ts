import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { bannerGenerationWorkflowRef, getBannerGeneration, getWorkflowStep, type BannerGeneration } from '@line-crm/db';
import type { BannerGenerationRequest, WorkerBindings } from '../worker-bindings.js';
import { processBannerGeneration } from './banner-jobs.js';
import { BANNER_MAX_COUNT } from './banner-prompt.js';
import { qaEnvironment, qaOutboundStopped } from './staging-qa-safety.js';

function isPending(generation: BannerGeneration | null): boolean {
  return !!generation && !generation.stop_requested_at
    && (generation.status === 'queued' || generation.status === 'running');
}

async function processWorkflowImage(env: WorkerBindings, request: BannerGenerationRequest): Promise<boolean> {
  const { generationId, tenantId } = request;
  if (qaOutboundStopped(env)) throw new Error('banner_generation_outbound_paused');
  if (env.DEPLOY_ENV === 'staging') {
    if (!qaEnvironment(env)) return true;
    const checkpoint = await getWorkflowStep(env.DB, bannerGenerationWorkflowRef(tenantId, generationId));
    if (!checkpoint?.input_json || JSON.parse(checkpoint.input_json).stagingAccepted !== true) return true;
  }
  if (!isPending(await getBannerGeneration(env.DB, generationId, tenantId))) return true;

  const imageId = await processBannerGeneration(env, generationId, tenantId).catch(() => null);
  if (!isPending(await getBannerGeneration(env.DB, generationId, tenantId))) return true;
  // Another invocation may currently own the generation or this tenant's quota lease.
  if (!imageId) throw new Error('banner_generation_pending');
  return false;
}

export class BannerGenerationWorkflow extends WorkflowEntrypoint<WorkerBindings, BannerGenerationRequest> {
  async run(event: WorkflowEvent<BannerGenerationRequest>, step: WorkflowStep): Promise<void> {
    for (let image = 1; image <= BANNER_MAX_COUNT; image += 1) {
      const finished = await step.do(`Generate banner image ${image}`, {
        retries: { limit: 10, delay: '30 seconds', backoff: 'constant' },
        timeout: '4 minutes',
      }, () => processWorkflowImage(this.env, event.payload));
      if (finished) return;
    }
  }
}
