import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

const REVIEW_STATUSES = ['new', 'approved', 'skipped'] as const;

export class UpdateReviewStatusDto {
  @ApiProperty({ enum: REVIEW_STATUSES })
  @IsIn(REVIEW_STATUSES)
  reviewStatus!: (typeof REVIEW_STATUSES)[number];
}
