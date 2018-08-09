pragma solidity ^0.4.18;

contract Sha256 {
    function Sha256() public {

    }

    event PrintB(bytes32 sign);
    event PrintU(uint256 sign);

    function calc(uint256 id)  external returns(bytes32 sign) {
        sign = sha256(this, id);
        PrintU(id);
        PrintB(sign);
    }
}