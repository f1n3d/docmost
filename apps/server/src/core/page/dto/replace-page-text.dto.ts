import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PageIdDto } from './page.dto';

export class ReplacePageTextDto extends PageIdDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(10000)
  oldText: string;

  // an empty string removes the text
  @IsString()
  @MaxLength(10000)
  newText: string;

  @IsOptional()
  @IsBoolean()
  replaceAll?: boolean;
}
