import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  MessageCircle,
  ChevronLeft,
  PlusCircle,
  X,
  Send,
  AlertTriangle,
  Package,
  Truck,
  CreditCard,
  Smartphone,
  RotateCcw,
  MoreHorizontal,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { useToast } from '@shared/components/ui/Toast';
import { customerApi } from '../services/customerApi';
import { Button } from '@/components/ui/button';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';

const COMPLAINT_CATEGORIES = [
  { id: 'order', label: 'Order issue', icon: Package, subject: 'Order complaint' },
  { id: 'parcel', label: 'Courier delivery', icon: Truck, subject: 'Courier complaint' },
  { id: 'payment', label: 'Payment / refund', icon: CreditCard, subject: 'Payment complaint' },
  { id: 'delivery', label: 'Delivery partner', icon: Truck, subject: 'Delivery complaint' },
  { id: 'product', label: 'Product quality', icon: AlertTriangle, subject: 'Product quality complaint' },
  { id: 'refund', label: 'Refund request', icon: RotateCcw, subject: 'Refund request' },
  { id: 'app', label: 'App / technical', icon: Smartphone, subject: 'App issue' },
  { id: 'other', label: 'Something else', icon: MoreHorizontal, subject: 'General complaint' },
];

const statusTone = (status) => {
  if (status === 'closed') return 'bg-slate-100 text-slate-600';
  if (status === 'processing') return 'bg-amber-100 text-amber-800';
  return 'bg-emerald-100 text-emerald-800';
};

const SupportPage = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();

  const [isTicketModalOpen, setIsTicketModalOpen] = useState(false);
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketsLoading, setTicketsLoading] = useState(true);
  const [myTickets, setMyTickets] = useState([]);
  const [ticketData, setTicketData] = useState({
    subject: '',
    description: '',
    priority: 'medium',
    category: 'other',
    relatedOrderId: '',
    relatedParcelId: '',
  });

  const fetchMyTickets = useCallback(async () => {
    try {
      setTicketsLoading(true);
      const res = await customerApi.getMyTickets();
      const list = res.data?.result || res.data?.results || [];
      setMyTickets(Array.isArray(list) ? list : []);
    } catch {
      setMyTickets([]);
    } finally {
      setTicketsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMyTickets();
  }, [fetchMyTickets]);

  // Deep-link: /support?complaint=1&category=order&orderId=...
  useEffect(() => {
    const open = searchParams.get('complaint') || searchParams.get('raise');
    if (!open) return;
    const category = String(searchParams.get('category') || 'other').toLowerCase();
    const cat = COMPLAINT_CATEGORIES.find((c) => c.id === category) || COMPLAINT_CATEGORIES[7];
    const orderId = searchParams.get('orderId') || '';
    const parcelId = searchParams.get('parcelId') || '';
    setTicketData((prev) => ({
      ...prev,
      category: cat.id,
      subject: searchParams.get('subject') || cat.subject,
      relatedOrderId: orderId,
      relatedParcelId: parcelId,
      description: searchParams.get('description') || prev.description,
    }));
    setIsTicketModalOpen(true);
  }, [searchParams]);

  const openComplaint = (categoryId = 'other') => {
    const cat = COMPLAINT_CATEGORIES.find((c) => c.id === categoryId) || COMPLAINT_CATEGORIES[7];
    setTicketData({
      subject: cat.subject,
      description: '',
      priority: categoryId === 'payment' || categoryId === 'refund' ? 'high' : 'medium',
      category: cat.id,
      relatedOrderId: '',
      relatedParcelId: '',
    });
    setIsTicketModalOpen(true);
  };

  const handleTicketSubmit = async (e) => {
    e.preventDefault();
    try {
      setTicketLoading(true);
      const res = await customerApi.createTicket({
        ...ticketData,
        userType: 'User',
      });
      if (res.data.success) {
        const ticket = res.data.result;
        showToast('Complaint sent to admin. We will respond soon.', 'success');
        setIsTicketModalOpen(false);
        setTicketData({
          subject: '',
          description: '',
          priority: 'medium',
          category: 'other',
          relatedOrderId: '',
          relatedParcelId: '',
        });
        await fetchMyTickets();
        if (ticket?._id) {
          navigate(`/chat?ticketId=${ticket._id}`);
        }
      }
    } catch (error) {
      showToast(error.response?.data?.message || 'Failed to submit complaint', 'error');
    } finally {
      setTicketLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 pb-24 font-sans">
      <div className="sticky top-0 z-30 bg-slate-50/95 backdrop-blur-sm px-4 pt-4 pb-3 border-b border-slate-200/60 mb-4 flex items-center gap-2">
        <button
          onClick={() => navigate(-1)}
          className="w-10 h-10 flex items-center justify-center hover:bg-slate-200/70 rounded-full transition-colors -ml-1"
        >
          <ChevronLeft size={22} className="text-slate-800" />
        </button>
        <h1 className="text-xl font-semibold text-slate-900 tracking-tight">Help & Support</h1>
      </div>

      <div className="max-w-2xl mx-auto px-4 pt-1 relative z-20 space-y-5">
        {/* Primary complaint CTA */}
        <button
          type="button"
          onClick={() => openComplaint('other')}
          className="w-full text-left rounded-2xl p-5 text-white shadow-lg relative overflow-hidden"
          style={{
            background: 'linear-gradient(to bottom right, var(--brand-900), var(--brand-600))',
          }}
        >
          <div className="relative z-10 flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-wider text-white/75">
                File a complaint
              </p>
              <p className="text-lg font-black mt-1">Tell admin what went wrong</p>
              <p className="text-xs text-white/80 mt-1 font-medium">
                Order, courier, payment, delivery — anything. Admin will reply.
              </p>
            </div>
            <div className="h-12 w-12 rounded-2xl bg-white/15 flex items-center justify-center shrink-0">
              <AlertTriangle size={22} />
            </div>
          </div>
        </button>

        {/* Quick categories */}
        <div>
          <h2 className="text-sm font-semibold text-slate-800 mb-3 px-1">Complaint type</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {COMPLAINT_CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => openComplaint(cat.id)}
                className="bg-white p-3 rounded-xl border border-slate-200 flex flex-col items-center text-center gap-2 hover:border-primary/40 hover:bg-slate-50 transition-colors"
              >
                <div className="h-9 w-9 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
                  <cat.icon size={18} />
                </div>
                <span className="text-[11px] font-bold text-slate-800 leading-tight">{cat.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* New complaint */}
        <div>
          <ContactCard
            icon={PlusCircle}
            label="New Complaint"
            sub="Write details"
            onClick={() => openComplaint('other')}
          />
        </div>

        {/* My complaints */}
        <div>
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="text-sm font-semibold text-slate-800">My complaints</h2>
            <button
              type="button"
              onClick={fetchMyTickets}
              className="text-[10px] font-bold uppercase tracking-wider text-primary"
            >
              Refresh
            </button>
          </div>
          {ticketsLoading ? (
            <div className="bg-white rounded-2xl border border-slate-100 p-6 text-center text-sm text-slate-400">
              Loading…
            </div>
          ) : myTickets.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-100 p-6 text-center space-y-2">
              <p className="text-sm font-bold text-slate-700">No complaints yet</p>
              <p className="text-xs text-slate-500">
                When you file one, it appears here and on Admin → Help Tickets.
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {myTickets.map((ticket) => (
                <button
                  key={ticket._id}
                  type="button"
                  onClick={() => navigate(`/chat?ticketId=${ticket._id}`)}
                  className="w-full text-left bg-white rounded-2xl border border-slate-100 p-4 hover:border-slate-200 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-bold text-slate-900 truncate">{ticket.subject}</p>
                        {ticket.unreadCount > 0 && (
                          <span className="shrink-0 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-black text-white">
                            {ticket.unreadCount}
                          </span>
                        )}
                      </div>
                      {ticket.ticketNumber && (
                        <p className="text-[10px] font-mono text-slate-400 mt-0.5">{ticket.ticketNumber}</p>
                      )}
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2">{ticket.description}</p>
                      <div className="flex items-center gap-2 mt-2 flex-wrap">
                        {ticket.category && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-50 px-2 py-0.5 rounded-full">
                            {ticket.category}
                          </span>
                        )}
                        {ticket.status === 'closed' && ticket.rating == null && (
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">
                            Rate this
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400 font-medium flex items-center gap-1">
                          <Clock size={11} />
                          {ticket.createdAt
                            ? new Date(ticket.createdAt).toLocaleDateString('en-IN', {
                                day: 'numeric',
                                month: 'short',
                              })
                            : ''}
                        </span>
                      </div>
                    </div>
                    <span
                      className={cn(
                        'text-[10px] font-black uppercase px-2 py-1 rounded-full shrink-0',
                        statusTone(ticket.status),
                      )}
                    >
                      {ticket.status === 'processing' ? 'In progress' : ticket.status}
                    </span>
                  </div>
                  <p className="text-[11px] font-bold text-primary mt-3 flex items-center gap-1">
                    <MessageCircle size={12} /> Open chat with admin
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* Complaint modal */}
      <AnimatePresence>
        {isTicketModalOpen && (
          <div className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center p-0 sm:p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsTicketModalOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative bg-white w-full max-w-lg rounded-t-[2.5rem] sm:rounded-3xl shadow-2xl overflow-hidden z-10 max-h-[92vh] overflow-y-auto"
            >
              <div className="p-6 sm:p-8">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h2 className="text-xl font-black text-slate-800">File a complaint</h2>
                    <p className="text-sm text-slate-500 font-medium">Admin will see this and can reply</p>
                  </div>
                  <button
                    onClick={() => setIsTicketModalOpen(false)}
                    className="w-10 h-10 flex items-center justify-center bg-slate-50 rounded-full text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    <X size={20} />
                  </button>
                </div>

                <form onSubmit={handleTicketSubmit} className="space-y-5">
                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">
                      Category
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {COMPLAINT_CATEGORIES.map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() =>
                            setTicketData((prev) => ({
                              ...prev,
                              category: cat.id,
                              subject: prev.subject?.trim() ? prev.subject : cat.subject,
                            }))
                          }
                          className={cn(
                            'px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors',
                            ticketData.category === cat.id
                              ? 'bg-primary text-white border-primary'
                              : 'bg-white text-slate-600 border-slate-200',
                          )}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">
                      Subject
                    </label>
                    <input
                      type="text"
                      required
                      value={ticketData.subject}
                      onChange={(e) => setTicketData({ ...ticketData, subject: e.target.value })}
                      placeholder="Short summary of your complaint"
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold outline-none ring-1 ring-transparent focus:ring-primary/20 transition-all"
                    />
                  </div>

                  {(ticketData.category === 'order' || ticketData.category === 'refund') && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">
                        Order ID (optional)
                      </label>
                      <input
                        type="text"
                        value={ticketData.relatedOrderId}
                        onChange={(e) =>
                          setTicketData({ ...ticketData, relatedOrderId: e.target.value })
                        }
                        placeholder="e.g. ORD-123456"
                        className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold outline-none ring-1 ring-transparent focus:ring-primary/20 transition-all"
                      />
                    </div>
                  )}

                  {ticketData.category === 'parcel' && (
                    <div className="space-y-2">
                      <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">
                        Courier ID (optional)
                      </label>
                      <input
                        type="text"
                        value={ticketData.relatedParcelId}
                        onChange={(e) =>
                          setTicketData({ ...ticketData, relatedParcelId: e.target.value })
                        }
                        placeholder="Courier ID ending digits are fine"
                        className="w-full bg-slate-50 border-none rounded-2xl px-5 py-3.5 text-sm font-bold outline-none ring-1 ring-transparent focus:ring-primary/20 transition-all"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-3 gap-3">
                    {['low', 'medium', 'high'].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setTicketData({ ...ticketData, priority: p })}
                        className={cn(
                          'py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border',
                          ticketData.priority === p
                            ? 'bg-primary text-primary-foreground border-primary shadow-lg shadow-brand-100'
                            : 'bg-white text-slate-400 border-slate-100 hover:bg-slate-50',
                        )}
                      >
                        {p}
                      </button>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest px-1">
                      What happened?
                    </label>
                    <textarea
                      required
                      value={ticketData.description}
                      onChange={(e) => setTicketData({ ...ticketData, description: e.target.value })}
                      placeholder="Explain your complaint clearly. Include order/courier details if useful."
                      className="w-full bg-slate-50 border-none rounded-2xl px-5 py-4 text-sm font-bold min-h-[140px] outline-none ring-1 ring-transparent focus:ring-primary/20 transition-all"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={ticketLoading}
                    className="w-full h-14 bg-primary hover:bg-[#0b721b] text-white text-base font-black rounded-2xl shadow-xl shadow-brand-100 transition-all active:scale-95"
                  >
                    {ticketLoading ? (
                      <div className="flex items-center gap-2 justify-center w-full">
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        SUBMITTING...
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 justify-center w-full">
                        <Send size={18} /> SUBMIT TO ADMIN
                      </div>
                    )}
                  </Button>
                  <p className="text-[11px] text-center text-slate-400 font-medium flex items-center justify-center gap-1">
                    <CheckCircle2 size={12} /> Visible in Admin → Help Tickets
                  </p>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const ContactCard = ({ icon: Icon, label, sub, to, onClick }) => {
  const CardContent = (
    <div
      onClick={onClick}
      className="bg-white p-3.5 rounded-xl border border-slate-200 flex flex-col items-center justify-center text-center gap-2 hover:bg-slate-50 transition-colors cursor-pointer group h-full"
    >
      <div className="h-10 w-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600 group-hover:text-slate-800 transition-colors">
        <Icon size={20} />
      </div>
      <div>
        <h3 className="font-semibold text-slate-800 text-sm whitespace-nowrap">{label}</h3>
        <p className="text-[10px] text-slate-500 font-medium">{sub}</p>
      </div>
    </div>
  );

  return to ? (
    <Link to={to} className="block h-full">
      {CardContent}
    </Link>
  ) : (
    CardContent
  );
};

export default SupportPage;
