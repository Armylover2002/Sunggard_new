import Faq from "../models/faq.js";
import handleResponse from "../utils/helper.js";

/**
 * Public, unauthenticated: GET /public/faqs?category=Customer&status=published
 * `status` defaults to "published" so a caller that forgets it never sees drafts.
 */
export const getPublicFaqs = async (req, res) => {
    try {
        const category = String(req.query?.category || "").trim();
        const status = String(req.query?.status || "published").trim();

        const filter = { status };
        if (category) filter.category = category;

        const faqs = await Faq.find(filter).sort({ order: 1, createdAt: 1 }).lean();

        return handleResponse(res, 200, "FAQs fetched", faqs);
    } catch (error) {
        return handleResponse(res, 500, error.message);
    }
};
