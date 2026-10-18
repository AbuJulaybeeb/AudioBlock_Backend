import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListSongsQueryDTO } from '../dtos/ListSongsQueryDTO';

async function errorsFor(query: Record<string, unknown>) {
  const dto = plainToInstance(ListSongsQueryDTO, query, { enableImplicitConversion: true });
  return (await validate(dto)).map((e) => e.property);
}

describe('ListSongsQueryDTO (#811)', () => {
  it('accepts an empty query', async () => {
    expect(await errorsFor({})).toEqual([]);
  });

  it('accepts every supported parameter', async () => {
    expect(
      await errorsFor({
        page: '2',
        limit: '100',
        artistId: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
        genreId: '3f2b8c1e-5d4a-4e6b-9a7c-1b2d3e4f5a6b',
        tag: 'lofi',
        mintStatus: 'minted',
        sort: 'popular',
        status: 'ready',
      }),
    ).toEqual([]);
  });

  it('bounds limit to 100', async () => {
    expect(await errorsFor({ limit: '101' })).toEqual(['limit']);
    expect(await errorsFor({ limit: '0' })).toEqual(['limit']);
  });

  it('rejects invalid values', async () => {
    expect(await errorsFor({ page: 'abc' })).toEqual(['page']);
    expect(await errorsFor({ artistId: 'nope' })).toEqual(['artistId']);
    expect(await errorsFor({ sort: 'random' })).toEqual(['sort']);
    expect(await errorsFor({ mintStatus: 'sold' })).toEqual(['mintStatus']);
    expect(await errorsFor({ status: 'deleted' })).toEqual(['status']);
  });
});
