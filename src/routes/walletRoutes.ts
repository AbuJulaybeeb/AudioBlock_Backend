import { Router } from 'express';
import { WalletController } from '../controllers/WalletController';
import { validateDTO } from '../middlewares/validate';
import { SignMessageDTO } from '../dtos/SignMessageDTO';
import { requireAuth } from '../middlewares/authMiddleware';
import { requireLegacyEvmAuth } from '../middlewares/legacyEvmGate';

const walletController = new WalletController();
const router = Router();

// Dynamic Labs EVM wallet routes are legacy and answer 410 unless
// ENABLE_LEGACY_EVM_AUTH=true (Issue #809).
router.post('/evm/create', requireLegacyEvmAuth, walletController.createEvmWallet);
router.post(
  '/evm/signMessage',
  requireLegacyEvmAuth,
  validateDTO(SignMessageDTO),
  walletController.signMessage,
);

// Wallet balance history (Issue #84)
router.get('/history', requireAuth, walletController.getWalletHistory);

export default router;
