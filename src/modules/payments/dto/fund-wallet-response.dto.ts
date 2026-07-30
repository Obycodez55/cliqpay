import { ApiProperty } from '@nestjs/swagger';

export class FundWalletResponseDto {
  @ApiProperty({
    example: 'https://checkout.korapay.com/KPY-PI-202607301127c5g9IQ17000/pay',
  })
  checkoutUrl: string;
}
