import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { cn } from '@/lib/utils';

/**
 * Google's Places Autocomplete widget appends its suggestion dropdown
 * (`.pac-container`) directly to `<body>`, outside this dialog's own DOM
 * subtree. Radix's outside-click detection can't tell that apart from a
 * genuine click outside the modal, so without this guard, picking a
 * suggestion closes the dialog on pointerdown before the selection ever
 * registers. Any screen embedding a maps search box inside a Modal needs
 * this, so it lives here once rather than in every caller.
 */
const isInsidePlacesDropdown = (event) => {
    if (!event) return false;
    const target = event.target;
    if (target instanceof Element && Boolean(target.closest('.pac-container, .pac-item'))) {
        return true;
    }
    if (typeof event.composedPath === 'function') {
        return event.composedPath().some(
            (el) => el instanceof Element && (el.classList.contains('pac-container') || el.classList.contains('pac-item') || Boolean(el.closest?.('.pac-container')))
        );
    }
    return false;
};

const Modal = ({ isOpen, onClose, title, children, footer, size = 'md' }) => {
    const sizes = {
        sm: 'sm:max-w-md',
        md: 'sm:max-w-lg',
        lg: 'sm:max-w-2xl',
        xl: 'sm:max-w-4xl',
        full: 'sm:max-w-[95vw] h-[95vh]',
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent
                className={cn("overflow-hidden p-0", sizes[size])}
                onPointerDownOutside={(event) => {
                    if (isInsidePlacesDropdown(event)) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (isInsidePlacesDropdown(event)) event.preventDefault();
                }}
                onFocusOutside={(event) => {
                    if (isInsidePlacesDropdown(event)) event.preventDefault();
                }}
            >
                <DialogHeader className="px-6 pt-3 pb-2 border-b border-gray-100/50 bg-gray-50/10">
                    <DialogTitle className="text-2xl font-semibold text-gray-900">{title}</DialogTitle>
                    <DialogDescription className="sr-only">Modal content</DialogDescription>
                </DialogHeader>

                <div
                    className="px-6 pt-3 pb-5 max-h-[80vh] overflow-y-auto overscroll-contain touch-pan-y"
                    data-lenis-prevent
                    tabIndex={0}
                    onWheel={(e) => e.stopPropagation()}
                    onTouchMove={(e) => e.stopPropagation()}
                >
                    {children}
                </div>

                {footer && (
                    <DialogFooter className="px-6 py-4 bg-gray-50/30 border-t border-gray-100/50 sm:justify-end gap-3">
                        {footer}
                    </DialogFooter>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default Modal;

