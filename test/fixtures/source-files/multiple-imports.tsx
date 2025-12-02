import pageStyles from './Page.module.scss';
import buttonStyles from '../components/Button.module.css';
import * as headerCss from './Header.module.sass';
const legacyStyles = require('./Legacy.module.less');

export const Page = () => {
  return (
    <div className={pageStyles.wrapper}>
      <header className={headerCss.header}>
        <h1 className={headerCss.title}>Welcome</h1>
      </header>
      <main className={pageStyles.content}>
        <button className={buttonStyles.btn}>Click</button>
        <div className={legacyStyles.container}>Legacy</div>
      </main>
    </div>
  );
};
