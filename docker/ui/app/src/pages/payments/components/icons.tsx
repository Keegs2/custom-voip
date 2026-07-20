/**
 * Zero-prop icon components for the payments surfaces. This file exports ONLY
 * components (react-refresh/only-export-components), so it is safe to import
 * from sibling component files. Thin wrappers over lucide-react at a shared size.
 */

import {
  Wallet,
  CreditCard,
  Repeat,
  FileText,
  Plus,
  Coins,
  Bot,
  Zap,
  ShieldCheck,
  TrendingUp,
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Trash2,
} from 'lucide-react';

export const IconWallet = () => <Wallet size={18} strokeWidth={1.8} />;
export const IconCard = () => <CreditCard size={18} strokeWidth={1.8} />;
export const IconRecharge = () => <Repeat size={18} strokeWidth={1.8} />;
export const IconInvoice = () => <FileText size={18} strokeWidth={1.8} />;
export const IconPlus = () => <Plus size={16} strokeWidth={2.2} />;
export const IconCoins = () => <Coins size={18} strokeWidth={1.8} />;
export const IconAgent = () => <Bot size={18} strokeWidth={1.8} />;
export const IconZap = () => <Zap size={16} strokeWidth={1.9} />;
export const IconShield = () => <ShieldCheck size={18} strokeWidth={1.8} />;
export const IconTrend = () => <TrendingUp size={18} strokeWidth={1.8} />;
export const IconActivity = () => <Activity size={16} strokeWidth={1.9} />;
export const IconRefresh = () => <RefreshCw size={14} strokeWidth={2} />;
export const IconWarn = () => <AlertTriangle size={16} strokeWidth={1.9} />;
export const IconCheck = () => <CheckCircle2 size={16} strokeWidth={2} />;
export const IconTrash = () => <Trash2 size={15} strokeWidth={1.9} />;
