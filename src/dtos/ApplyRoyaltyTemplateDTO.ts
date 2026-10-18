import { IsUUID } from 'class-validator';

export class ApplyRoyaltyTemplateDTO {
  @IsUUID('4', { message: 'templateId must be a valid template id.' })
  templateId!: string;
}
