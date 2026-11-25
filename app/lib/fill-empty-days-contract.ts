import type { FillEmptyDaysPreview } from "./fill-empty-days-review";

export interface FillEmptyDaysPreviewRequest {
  week: string;
  seed: number;
  preferReviewedMains: boolean;
  expectedRevision: number;
  /** Browser timezone for a standalone kitchen. Shared kitchens use their saved timezone. */
  timezone?: string;
}

export interface FillEmptyDaysReview extends FillEmptyDaysPreviewRequest {
  timezone: string;
  today: string;
  catalogRevision: number;
  digest: string;
}

export interface FillEmptyDaysPreviewResponse {
  preview: FillEmptyDaysPreview;
  review: FillEmptyDaysReview;
}

export interface FillEmptyDaysApplyRequest {
  review: FillEmptyDaysReview;
  commandId: string;
}
