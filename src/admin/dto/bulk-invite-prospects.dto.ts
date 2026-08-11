import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
} from 'class-validator';

// Comfortably above the ~30,000 the user described, while still bounding a
// single request — a larger list is a "run it twice" problem, not a reason
// to raise this further.
const MAX_BULK_EMAILS = 50_000;

// Deliberately NOT @IsEmail(each: true) here — a real 30k-row CSV will
// always have a handful of typo'd/malformed rows, and failing the entire
// request over one bad row would defeat the point of a bulk upload. Real
// email-shape validation happens per-row in AdminService.inviteProspectsBulk,
// which sorts each entry into sent/skipped/invalid and reports all three
// counts back — this DTO only bounds size and rejects obvious garbage.
export class BulkInviteProspectsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_EMAILS)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  emails!: string[];
}
