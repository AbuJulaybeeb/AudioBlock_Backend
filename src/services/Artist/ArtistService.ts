import { Repository } from 'typeorm';
import { User } from '../../entities/User';
import { AppError } from '../../errors/AppError';
import AppDataSource from '../../config/db';
import { SorobanContracts } from '../../config/soroban';
import { SorobanService, addressArg, stringArg } from '../Soroban/SorobanService';

export interface PreparedTransaction {
  xdr: string;
  networkPassphrase: string;
}

export class ArtistService {
  private userRepo: Repository<User>;
  private soroban: SorobanService;

  constructor() {
    this.userRepo = AppDataSource.getRepository(User);
    this.soroban = new SorobanService();
  }

  /**
   * Records the Stellar public key (e.g. from Freighter wallet) that the artist
   * will use to sign on-chain transactions.
   *
   * @param userId - ID of the artist user.
   * @param stellarPublicKey - The Stellar account's public key.
   * @returns Updated User entity with the connected wallet.
   * @throws {Error} If user not found.
   */
  async connectStellarWallet(userId: string, stellarPublicKey: string): Promise<User> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new Error('User not found');

    user.stellarPublicKey = stellarPublicKey;
    return this.userRepo.save(user);
  }

  /**
   * Builds the unsigned `setup_artist_profile` Soroban transaction for the
   * artist contract. The artist must have a connected Stellar wallet and
   * provide a metadata CID.
   *
   * @param userId - ID of the artist user.
   * @param cid - IPFS CID of the artist profile metadata.
   * @returns PreparedTransaction containing the XDR and network passphrase.
   * @throws {AppError} 400 if no Stellar wallet, 409 if already registered.
   * @throws {Error} If user not found or CID missing.
   */
  async prepareArtistOnChainSetup(userId: string, cid: string): Promise<PreparedTransaction> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new Error('User not found');
    if (!user.stellarPublicKey) {
      throw AppError.validation(
        'Connect a Stellar wallet before setting up an on-chain artist profile',
      );
    }
    if (user.stellarArtistId) {
      throw AppError.conflict('Artist is already registered on-chain');
    }
    if (!cid) throw new Error('cid is required');

    const xdrTx = await this.soroban.prepareInvocation(
      user.stellarPublicKey,
      SorobanContracts.artist,
      'setup_artist_profile',
      [addressArg(user.stellarPublicKey), stringArg(cid)],
    );

    return { xdr: xdrTx, networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || '' };
  }

  /**
   * Submits the artist's signed `setup_artist_profile` transaction to Soroban,
   * persists the on-chain artist ID and token ID on the user record.
   *
   * @param userId - ID of the artist user.
   * @param signedXdr - The wallet-signed XDR transaction string.
   * @returns Transaction hash, on-chain artist ID, and token ID.
   * @throws {Error} If user not found or Soroban submission fails.
   */
  async submitArtistOnChainSetup(
    userId: string,
    signedXdr: string,
  ): Promise<{ txHash: string; artistId: string; tokenId: string }> {
    const user = await this.userRepo.findOneBy({ id: userId });
    if (!user) throw new Error('User not found');

    const { hash, returnValue } = await this.soroban.submitSignedTransaction(signedXdr);

    // setup_artist_profile returns (artist_id: u64, token_id: u64)
    const [artistId, tokenId] = returnValue as [bigint, bigint];

    // A retry of the same signed transaction yields the same ids; persist only once.
    if (
      user.stellarArtistId !== artistId.toString() ||
      user.stellarArtistTokenId !== tokenId.toString()
    ) {
      user.stellarArtistId = artistId.toString();
      user.stellarArtistTokenId = tokenId.toString();
      await this.userRepo.save(user);
    }

    return { txHash: hash, artistId: user.stellarArtistId, tokenId: user.stellarArtistTokenId };
  }
}
