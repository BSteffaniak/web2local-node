import styles from './Button.module.scss';
import clsx from 'clsx';

interface ButtonProps {
    variant?: 'primary' | 'secondary';
    disabled?: boolean;
    children: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
    variant = 'primary',
    disabled,
    children,
}) => {
    return (
        <button
            className={clsx(
                styles.container,
                styles[`variant-${variant}`],
                disabled && styles.disabled,
            )}
            disabled={disabled}
        >
            <span className={styles['btn-text']}>{children}</span>
            <span className={styles.icon}>arrow</span>
        </button>
    );
};
